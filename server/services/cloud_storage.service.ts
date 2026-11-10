import fs from 'fs';
import path from 'path';
import { adminApp } from '../middleware/auth.middleware';
import { getStorage } from 'firebase-admin/storage';
import { UPLOADS_DIR, EXPORTS_DIR, AUDIO_DIR } from './media.service';

/**
 * Cloud Storage Service for Khmersub Studio
 * Strictly separates media binaries (stored in Firebase Storage / disk) from Firestore documents.
 * Adheres to rule: Never store large video files in Firestore documents.
 */

let bucketInstance: ReturnType<typeof getStorage>['prototype']['bucket'] | null = null;
let isBucketAvailable = false;

try {
  const storage = getStorage(adminApp);
  const bucket = storage.bucket();
  bucketInstance = bucket;
  isBucketAvailable = Boolean(bucket && bucket.name);
  console.log(`[Storage] Firebase Storage bucket initialized: ${bucket.name}`);
} catch (err) {
  console.warn('[Storage] Firebase Storage bucket unavailable in local environment; using persistent local disk staging:', err);
  isBucketAvailable = false;
}

export interface StorageUploadResult {
  storagePath: string;
  publicUrl: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * Uploads a local media file to Firebase Storage bucket (if available)
 * Returns the Cloud Storage path and playable/download URL.
 */
export async function uploadMediaToCloudStorage(params: {
  localFilePath: string;
  destinationPath: string; // e.g. uploads/uid/projectId/video.mp4
  mimeType?: string;
  isPublic?: boolean;
}): Promise<StorageUploadResult> {
  const { localFilePath, destinationPath, mimeType = 'video/mp4' } = params;

  if (!fs.existsSync(localFilePath)) {
    throw new Error(`Local file not found for cloud upload: ${localFilePath}`);
  }

  const stat = fs.statSync(localFilePath);

  if (isBucketAvailable && bucketInstance) {
    try {
      const file = bucketInstance.file(destinationPath);
      await bucketInstance.upload(localFilePath, {
        destination: destinationPath,
        metadata: {
          contentType: mimeType,
          metadata: {
            sizeBytes: String(stat.size),
            uploadedAt: new Date().toISOString(),
          },
        },
      });

      // Try generating a v4 signed read URL valid for 7 days
      try {
        const [signedUrl] = await file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

        return {
          storagePath: `gs://${bucketInstance.name}/${destinationPath}`,
          publicUrl: signedUrl,
          sizeBytes: stat.size,
          mimeType,
        };
      } catch {
        // Fallback to internal media route if signed URLs require private key file
        return {
          storagePath: `gs://${bucketInstance.name}/${destinationPath}`,
          publicUrl: `/media/${destinationPath}`,
          sizeBytes: stat.size,
          mimeType,
        };
      }
    } catch (uploadErr) {
      console.warn(`[Storage] Cloud Storage upload to ${destinationPath} failed; falling back to local persistent storage:`, uploadErr);
    }
  }

  // Local persistent disk fallback
  return {
    storagePath: destinationPath,
    publicUrl: `/media/${destinationPath}`,
    sizeBytes: stat.size,
    mimeType,
  };
}

/**
 * Checks if a file exists in Cloud Storage or local disk
 */
export async function checkMediaExists(storagePath: string, localFallbackPath: string): Promise<boolean> {
  if (fs.existsSync(localFallbackPath)) return true;

  if (isBucketAvailable && bucketInstance && storagePath.startsWith('gs://')) {
    try {
      const relative = storagePath.replace(/^gs:\/\/[^/]+\//, '');
      const [exists] = await bucketInstance.file(relative).exists();
      return exists;
    } catch {
      return false;
    }
  }

  return false;
}
