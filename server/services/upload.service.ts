import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { UPLOADS_DIR } from './media.service';
/**
 * Strict identifier validator to prevent directory traversal and injection.
 */
export function isValidIdentifier(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 128 &&
    /^[a-zA-Z0-9_\-]+$/.test(id)
  );
}

/**
 * Strict file name validator to prevent directory traversal and null byte injections.
 */
export function isValidFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return false;
  }
  return /^[a-zA-Z0-9._\-]+$/.test(name);
}

const execFileAsync = promisify(execFile);

export const STAGING_DIR = path.join(UPLOADS_DIR, 'staging');
fs.mkdirSync(STAGING_DIR, { recursive: true });

export interface UploadSession {
  uploadId: string;
  ownerId: string;
  projectId: string;
  fileName: string;
  expectedSizeBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  chunkSizes: Map<number, number>;
  stagingDir: string;
  status: 'active' | 'assembling' | 'completed' | 'cancelled' | 'failed';
  errorMessage?: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
}

// In-memory session registry (authoritative)
export const activeSessions = new Map<string, UploadSession>();

/**
 * Creates a new secure upload session for the authenticated user.
 */
export function createUploadSession(params: {
  uid: string;
  projectId: string;
  fileName: string;
  expectedSizeBytes: number;
  chunkSize: number;
  totalChunks: number;
}): UploadSession {
  const { uid, projectId, fileName, expectedSizeBytes, chunkSize, totalChunks } = params;

  if (!isValidIdentifier(uid)) {
    throw new Error('Invalid user identifier');
  }
  if (!isValidIdentifier(projectId)) {
    throw new Error('Invalid project identifier format');
  }
  if (!isValidFileName(fileName)) {
    throw new Error('Invalid file name format');
  }
  if (!Number.isFinite(expectedSizeBytes) || expectedSizeBytes <= 0) {
    throw new Error('Expected file size must be a positive number');
  }
  if (expectedSizeBytes > 5 * 1024 * 1024 * 1024) {
    throw new Error('File exceeds the 5 GB maximum upload limit');
  }
  if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
    throw new Error('Total chunks must be a positive integer');
  }

  const expectedCalculatedChunks = Math.ceil(expectedSizeBytes / chunkSize);
  if (totalChunks !== expectedCalculatedChunks) {
    throw new Error(
      `Total chunks mismatch: expected ${expectedCalculatedChunks} for chunkSize ${chunkSize}, got ${totalChunks}`
    );
  }

  const uploadId = `upsess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const stagingDir = path.resolve(STAGING_DIR, uploadId);
  fs.mkdirSync(stagingDir, { recursive: true });

  const now = Date.now();
  const session: UploadSession = {
    uploadId,
    ownerId: uid,
    projectId,
    fileName,
    expectedSizeBytes,
    chunkSize,
    totalChunks,
    receivedChunks: new Set<number>(),
    chunkSizes: new Map<number, number>(),
    stagingDir,
    status: 'active',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000, // 24 hours
  };

  activeSessions.set(uploadId, session);
  return session;
}

/**
 * Retrieves an active upload session, verifying ownership.
 */
export function getUploadSession(uploadId: string, uid: string): UploadSession {
  if (!isValidIdentifier(uploadId)) {
    const err = new Error('Invalid upload session ID format');
    (err as any).statusCode = 400;
    throw err;
  }

  const session = activeSessions.get(uploadId);
  if (!session) {
    const err = new Error('Upload session not found or has expired');
    (err as any).statusCode = 404;
    throw err;
  }

  // Cross-user access prevention (Task 13)
  if (session.ownerId !== uid) {
    const err = new Error('Forbidden: You do not have permission to access this upload session');
    (err as any).statusCode = 403;
    throw err;
  }

  return session;
}

/**
 * Stores a chunk into the session's staging directory.
 * Validates index, rejects duplicates, and prevents RAM overflow.
 */
export async function storeChunk(params: {
  uploadId: string;
  uid: string;
  chunkIndex: number;
  chunkBuffer: Buffer;
}): Promise<{
  receivedCount: number;
  totalChunks: number;
  uploadedBytes: number;
}> {
  const { uploadId, uid, chunkIndex, chunkBuffer } = params;
  const session = getUploadSession(uploadId, uid);

  if (session.status !== 'active') {
    const err = new Error(`Cannot upload chunk: session is ${session.status}`);
    (err as any).statusCode = 400;
    throw err;
  }

  // Validate chunk index bounds (Task 3)
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    const err = new Error(
      `Invalid chunk index ${chunkIndex}. Index must be between 0 and ${session.totalChunks - 1}`
    );
    (err as any).statusCode = 400;
    throw err;
  }

  // Reject duplicate chunks (Task 4)
  if (session.receivedChunks.has(chunkIndex)) {
    const err = new Error(`Duplicate chunk: chunk ${chunkIndex} has already been uploaded`);
    (err as any).statusCode = 409;
    throw err;
  }

  const chunkPath = path.resolve(session.stagingDir, `chunk_${chunkIndex}.part`);
  // Ensure chunk path is strictly inside stagingDir
  if (!chunkPath.startsWith(session.stagingDir + path.sep)) {
    const err = new Error('Path traversal detected');
    (err as any).statusCode = 403;
    throw err;
  }

  // Write chunk buffer to disk directly (Task 14)
  await fs.promises.writeFile(chunkPath, chunkBuffer);

  const chunkSize = chunkBuffer.length;
  session.receivedChunks.add(chunkIndex);
  session.chunkSizes.set(chunkIndex, chunkSize);
  session.lastActivityAt = Date.now();

  const uploadedBytes = Array.from(session.chunkSizes.values()).reduce((a, b) => a + b, 0);

  return {
    receivedCount: session.receivedChunks.size,
    totalChunks: session.totalChunks,
    uploadedBytes,
  };
}

/**
 * Validates actual media file content using container magic numbers AND ffprobe
 * (Task 7: Validate supported media formats using actual file content rather than trusting file extensions)
 */
export async function validateMediaContent(filePath: string): Promise<{
  isValid: boolean;
  mimeType: string;
  formatName: string;
  error?: string;
}> {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    const headerBuf = Buffer.alloc(16);
    await fd.read(headerBuf, 0, 16, 0);
    await fd.close();

    // 1. Magic bytes check
    const isFtyp =
      headerBuf.slice(4, 8).toString('ascii') === 'ftyp' ||
      headerBuf.slice(4, 8).toString('ascii') === 'moov';
    const isWebm =
      headerBuf[0] === 0x1a &&
      headerBuf[1] === 0x45 &&
      headerBuf[2] === 0xdf &&
      headerBuf[3] === 0xa3;
    const isRiffWave =
      headerBuf.slice(0, 4).toString('ascii') === 'RIFF' &&
      headerBuf.slice(8, 12).toString('ascii') === 'WAVE';
    const isId3Mp3 = headerBuf.slice(0, 3).toString('ascii') === 'ID3';
    const isSyncMp3 =
      headerBuf[0] === 0xff && (headerBuf[1] === 0xfb || headerBuf[1] === 0xf3 || headerBuf[1] === 0xf2);

    const hasKnownMagicHeader = isFtyp || isWebm || isRiffWave || isId3Mp3 || isSyncMp3;
    if (!hasKnownMagicHeader) {
      return {
        isValid: false,
        mimeType: 'application/octet-stream',
        formatName: 'unknown',
        error: 'File content does not contain a recognized video or audio container header',
      };
    }

    // 2. FFprobe deep container and stream validation
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration:stream=codec_type,codec_name',
      '-of',
      'default=noprint_wrappers=1',
      filePath,
    ]);

    const output = stdout.trim();
    if (!output || !output.includes('format_name=')) {
      return {
        isValid: false,
        mimeType: 'application/octet-stream',
        formatName: 'unknown',
        error: 'FFprobe could not parse valid media streams from file content',
      };
    }

    let formatName = 'mp4';
    if (output.includes('format_name=matroska,webm') || output.includes('webm')) {
      formatName = 'webm';
    } else if (output.includes('wav')) {
      formatName = 'wav';
    } else if (output.includes('mp3')) {
      formatName = 'mp3';
    } else if (output.includes('mov,mp4') || output.includes('isom')) {
      formatName = 'mp4';
    }

    const mimeMap: Record<string, string> = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
    };

    return {
      isValid: true,
      mimeType: mimeMap[formatName] || 'video/mp4',
      formatName,
    };
  } catch (err) {
    return {
      isValid: false,
      mimeType: 'application/octet-stream',
      formatName: 'invalid',
      error: err instanceof Error ? err.message : 'Corrupted or unreadable media file',
    };
  }
}

/**
 * Completes an upload session by verifying all chunks, assembling via Node.js streams,
 * validating container formats via ffprobe, and writing the final project file.
 */
export async function completeUploadSession(
  uploadId: string,
  uid: string
): Promise<{
  projectId: string;
  storagePath: string;
  videoFilePath: string;
  videoUrl: string;
  sizeBytes: number;
  mimeType: string;
  formatName: string;
}> {
  const session = getUploadSession(uploadId, uid);

  if (session.status !== 'active') {
    const err = new Error(`Cannot complete session in ${session.status} state`);
    (err as any).statusCode = 400;
    throw err;
  }

  // 1. Missing chunks validation (Task 5)
  if (session.receivedChunks.size !== session.totalChunks) {
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    const err = new Error(
      `Incomplete upload: missing ${missing.length} of ${session.totalChunks} chunks (missing indexes: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''})`
    );
    (err as any).statusCode = 400;
    (err as any).missingChunks = missing;
    throw err;
  }

  // 2. Expected total file size validation (Task 6)
  const totalReceivedBytes = Array.from(session.chunkSizes.values()).reduce((a, b) => a + b, 0);
  if (totalReceivedBytes !== session.expectedSizeBytes) {
    const err = new Error(
      `Total size mismatch: expected ${session.expectedSizeBytes} bytes, but received ${totalReceivedBytes} bytes`
    );
    (err as any).statusCode = 400;
    throw err;
  }

  session.status = 'assembling';

  const userProjectDir = path.resolve(UPLOADS_DIR, uid, session.projectId);
  fs.mkdirSync(userProjectDir, { recursive: true });

  const tempFinalPath = path.resolve(userProjectDir, `upload_assembly_${uploadId}.tmp`);
  const finalVideoPath = path.resolve(userProjectDir, 'video.mp4');

  try {
    // 3. Assemble chunks sequentially via streams (Task 14: Never load entire video into RAM)
    const writeStream = fs.createWriteStream(tempFinalPath, { flags: 'w' });

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.resolve(session.stagingDir, `chunk_${i}.part`);
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Critical: Chunk part file ${i} missing from disk`);
      }
      const readStream = fs.createReadStream(chunkPath);
      await pipeline(readStream, writeStream, { end: false });
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // 4. Verify assembled size matches expected size (Task 11)
    const assembledStat = await fs.promises.stat(tempFinalPath);
    if (assembledStat.size !== session.expectedSizeBytes) {
      throw new Error(
        `Assembled file size (${assembledStat.size}) does not match expected size (${session.expectedSizeBytes})`
      );
    }

    // 5. Deep media content format validation using ffprobe (Task 7)
    const mediaCheck = await validateMediaContent(tempFinalPath);
    if (!mediaCheck.isValid) {
      const err = new Error(
        `Invalid media format: actual file content is not a supported audio or video format (${mediaCheck.error})`
      );
      (err as any).statusCode = 400;
      throw err;
    }

    // Replace final video file atomically
    if (fs.existsSync(finalVideoPath)) {
      await fs.promises.unlink(finalVideoPath);
    }
    await fs.promises.rename(tempFinalPath, finalVideoPath);

    // Clean up staging chunks
    try {
      await fs.promises.rm(session.stagingDir, { recursive: true, force: true });
    } catch {
      // non-blocking
    }

    session.status = 'completed';

    const relativePath = `uploads/${uid}/${session.projectId}/video.mp4`;
    const videoUrl = `/media/${relativePath}`;

    return {
      projectId: session.projectId,
      storagePath: relativePath,
      videoFilePath: finalVideoPath,
      videoUrl,
      sizeBytes: assembledStat.size,
      mimeType: mediaCheck.mimeType,
      formatName: mediaCheck.formatName,
    };
  } catch (err) {
    session.status = 'failed';
    session.errorMessage = err instanceof Error ? err.message : String(err);
    if (fs.existsSync(tempFinalPath)) {
      try {
        await fs.promises.unlink(tempFinalPath);
      } catch {
        // non-blocking
      }
    }
    throw err;
  }
}

/**
 * Cancels an upload session and cleans up all staged chunks immediately.
 * (Task 8: Implement upload cancellation)
 */
export async function cancelUploadSession(
  uploadId: string,
  uid: string
): Promise<{ ok: boolean; cancelled: boolean }> {
  const session = getUploadSession(uploadId, uid);

  session.status = 'cancelled';
  try {
    if (fs.existsSync(session.stagingDir)) {
      await fs.promises.rm(session.stagingDir, { recursive: true, force: true });
    }
  } catch {
    // non-blocking
  }

  activeSessions.delete(uploadId);
  return { ok: true, cancelled: true };
}

/**
 * Periodically cleans up abandoned or expired upload sessions.
 * (Task 12: Clean up abandoned upload sessions)
 */
export function cleanupAbandonedUploadSessions(): { cleanedCount: number } {
  const now = Date.now();
  const maxInactiveMs = 60 * 60 * 1000; // 1 hour of inactivity
  let cleanedCount = 0;

  for (const [uploadId, session] of activeSessions.entries()) {
    const isExpired = now > session.expiresAt;
    const isAbandoned = now - session.lastActivityAt > maxInactiveMs;
    const isFinished = session.status === 'completed' || session.status === 'cancelled';

    if (isExpired || isAbandoned || isFinished) {
      try {
        if (fs.existsSync(session.stagingDir)) {
          fs.rmSync(session.stagingDir, { recursive: true, force: true });
        }
      } catch {
        // non-blocking
      }
      activeSessions.delete(uploadId);
      cleanedCount++;
    }
  }

  // Also sweep staging directory for orphaned folders older than 2 hours
  try {
    if (fs.existsSync(STAGING_DIR)) {
      const dirs = fs.readdirSync(STAGING_DIR);
      for (const d of dirs) {
        const full = path.join(STAGING_DIR, d);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory() && now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch {
          // non-blocking
        }
      }
    }
  } catch {
    // non-blocking
  }

  return { cleanedCount };
}

// Run cleanup every 15 minutes without holding event loop open
const cleanupInterval = setInterval(cleanupAbandonedUploadSessions, 15 * 60 * 1000);
if (cleanupInterval && typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}
