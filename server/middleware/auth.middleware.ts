import { Request, Response, NextFunction } from 'express';
import { initializeApp, getApps, getApp } from 'firebase-admin/app';
import { getAuth, DecodedIdToken } from 'firebase-admin/auth';
import fs from 'fs';
import path from 'path';

export interface AuthenticatedRequest extends Request {
  user?: DecodedIdToken;
  uid?: string;
}

// Read configuration from firebase-applet-config.json
let firebaseProjectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
if (!firebaseProjectId) {
  try {
    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      firebaseProjectId = config.projectId;
    }
  } catch (err) {
    console.error('Failed to parse firebase-applet-config.json for Firebase Admin:', err);
  }
}

// Initialize Firebase Admin SDK app as a singleton
const adminApp = getApps().length
  ? getApp()
  : initializeApp({
      projectId: firebaseProjectId || 'online-fuze-s01dl',
    });

const adminAuth = getAuth(adminApp);

/**
 * Extracts Bearer token from the standard Authorization header
 * or ?token= query parameter (for direct media streaming like audio/video elements and static links)
 */
export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  // Query parameter fallback for streaming <video> and <audio> tags or file streaming
  if (req.query?.token && typeof req.query.token === 'string') {
    return req.query.token.trim();
  }

  return null;
}

/**
 * Express middleware that validates the Firebase ID token in Authorization: Bearer <token>.
 * Rejects unauthenticated requests with HTTP 401.
 * Sets req.user (DecodedIdToken) and req.uid (verified string).
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req);

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized: Missing or invalid Authorization Bearer token',
    });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;
    req.uid = decodedToken.uid;
    next();
  } catch (err) {
    console.warn('Firebase ID token verification failed:', err instanceof Error ? err.message : err);
    res.status(401).json({
      error: 'Unauthorized: Invalid or expired authentication token',
    });
  }
}

/**
 * Express middleware for media endpoints that validates user ownership
 * or allows authenticated users access only to their own /media paths.
 */
export async function authenticateMediaAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req);

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized: Authentication required to access media file',
    });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;
    req.uid = decodedToken.uid;

    // Check if URL targets a specific user folder, e.g. /media/uploads/:uid/... or /media/audio/:uid/...
    // req.path starts after mount point, e.g. /:uid/:projectId/video.mp4
    const pathParts = req.path.split('/').filter(Boolean);
    const targetFolderUid = pathParts[0];

    // If accessing a user-scoped media folder, only the verified user can access it
    if (targetFolderUid && targetFolderUid !== decodedToken.uid) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to access media belonging to another user',
      });
      return;
    }

    next();
  } catch (err) {
    console.warn('Media token verification failed:', err instanceof Error ? err.message : err);
    res.status(401).json({
      error: 'Unauthorized: Invalid or expired authentication token',
    });
  }
}

export { adminApp, adminAuth };
