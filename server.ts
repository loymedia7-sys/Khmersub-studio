import express, { Response as ExpressResponse } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import {
  AsrProvider,
  CaptionTemplate,
  ExportFormat,
  JobRecord,
  LanguageOption,
  SubtitleSegment,
  WordsPerSegmentOption,
  sanitizeId,
} from './shared/segment.schema';
import {
  AUDIO_DIR,
  EXPORTS_DIR,
  FONTS_DIR,
  UPLOADS_DIR,
  burnSubtitlesWithFfmpeg,
  ensureDemoVideoClip,
  extractAudioToWav,
  probeVideoDuration,
} from './server/services/media.service';
import {
  chatWithTranscriptGemini,
  generateAiTranscriptAnalysis,
  transcribeAudioWithGemini,
  translateSegmentsGemini,
} from './server/services/asr.service';
import { writeSubtitleExportFile } from './server/services/subtitle.service';
import {
  AuthenticatedRequest,
  requireAuth,
  authenticateMediaAccess,
} from './server/middleware/auth.middleware';
import {
  createUploadSession,
  getUploadSession,
  storeChunk,
  completeUploadSession,
  cancelUploadSession,
  validateMediaContent,
} from './server/services/upload.service';

dotenv.config();

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '50mb' }));

// Fonts are public typographic assets for browser @font-face rendering
app.use('/media/fonts', express.static(FONTS_DIR));

interface ServerProjectState {
  projectId: string;
  ownerId: string;
  title: string;
  videoFilePath: string;
  videoUrl: string;
  audioFilePath: string;
  audioUrl: string;
  durationSec: number;
  sizeBytes: number;
  mimeType: string;
  language: LanguageOption;
  wordsPerSegment: WordsPerSegmentOption;
  status: string;
  segments: SubtitleSegment[];
  latestDownloadPath?: string;
  latestDownloadFormat?: ExportFormat;
}

const serverProjects = new Map<string, ServerProjectState>();
const serverJobs = new Map<string, JobRecord>();

/**
 * Strict identifier validator to prevent directory traversal, path injection, and command abuse.
 * Allows only alphanumeric chars, underscores, and hyphens (1-128 chars).
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
 * Prohibits '..', slashes, backslashes, and null bytes.
 */
export function isValidFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return false;
  }
  return /^[a-zA-Z0-9._\-]+$/.test(name);
}

/**
 * Verifies that a project belongs to the authenticated user.
 * Never trusts client-supplied project IDs without verification.
 * Distinguishes between project owned by user, project owned by another user (403), or non-existent (404).
 */
export async function verifyProjectOwnership(
  uid: string,
  projectId: string
): Promise<{ isOwner: boolean; exists: boolean; actualOwnerId?: string }> {
  if (!isValidIdentifier(uid) || !isValidIdentifier(projectId)) {
    return { isOwner: false, exists: false };
  }

  // 1. Check in-memory server state
  const inMemory = serverProjects.get(projectId);
  if (inMemory) {
    return {
      isOwner: inMemory.ownerId === uid,
      exists: true,
      actualOwnerId: inMemory.ownerId,
    };
  }

  // 2. Check local disk project metadata for this user
  const userProjectMeta = path.resolve(UPLOADS_DIR, uid, projectId, 'project.json');
  if (fs.existsSync(userProjectMeta)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(userProjectMeta, 'utf-8'));
      if (parsed.ownerId === uid) {
        return { isOwner: true, exists: true, actualOwnerId: uid };
      }
    } catch {
      // non-blocking
    }
  }

  // 3. Check if user's own project directory exists on disk
  const userUploadDir = path.resolve(UPLOADS_DIR, uid, projectId);
  const userExportDir = path.resolve(EXPORTS_DIR, uid, projectId);
  const baseUpload = path.resolve(UPLOADS_DIR, uid);
  const baseExport = path.resolve(EXPORTS_DIR, uid);

  if (
    (userUploadDir.startsWith(baseUpload + path.sep) && fs.existsSync(userUploadDir)) ||
    (userExportDir.startsWith(baseExport + path.sep) && fs.existsSync(userExportDir))
  ) {
    return { isOwner: true, exists: true, actualOwnerId: uid };
  }

  // 4. Check if project is registered to another user (for 403 Forbidden vs 404 Not Found)
  for (const [id, p] of serverProjects.entries()) {
    if (id === projectId) {
      return { isOwner: false, exists: true, actualOwnerId: p.ownerId };
    }
  }

  try {
    if (fs.existsSync(UPLOADS_DIR)) {
      const allUsers = fs.readdirSync(UPLOADS_DIR);
      for (const otherUser of allUsers) {
        if (otherUser !== uid && isValidIdentifier(otherUser)) {
          const otherDir = path.resolve(UPLOADS_DIR, otherUser, projectId);
          if (fs.existsSync(otherDir)) {
            return { isOwner: false, exists: true, actualOwnerId: otherUser };
          }
        }
      }
    }
  } catch {
    // non-blocking
  }

  return { isOwner: false, exists: false };
}

const MIME_TYPE_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.doc': 'application/msword; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Handles authenticated streaming and file downloads for private user files.
 * Enforces:
 * - Authenticated token validation
 * - User folder isolation (route UID must match token UID)
 * - Project ownership verification against the database
 * - Directory traversal prevention (strict containment within baseDir/uid/projectId)
 * - HTTP 206 Partial Content Range requests for video seeking
 */
async function handleSecureMediaStream(
  req: AuthenticatedRequest,
  res: ExpressResponse,
  baseDir: string,
  mediaType: 'upload' | 'audio' | 'export'
): Promise<void> {
  const authUid = req.uid;
  if (!authUid) {
    res.status(401).json({ error: 'Unauthorized: Authentication required to access media file' });
    return;
  }

  const { uid: routeUid, projectId, fileName } = req.params;

  // 1. Strict validation of identifiers
  if (
    !isValidIdentifier(authUid) ||
    !isValidIdentifier(routeUid) ||
    !isValidIdentifier(projectId) ||
    !isValidFileName(fileName)
  ) {
    res.status(400).json({ error: 'Bad Request: Invalid identifier or file name format' });
    return;
  }

  // 2. Cross-user access check: User A accessing User B's folder is strictly forbidden
  if (routeUid !== authUid) {
    res.status(403).json({
      error: 'Forbidden: You do not have permission to access media belonging to another user',
    });
    return;
  }

  // 3. Project ownership verification against database
  const ownership = await verifyProjectOwnership(authUid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({
        error: 'Forbidden: You do not have permission to access this project\'s files',
      });
    } else {
      res.status(404).json({ error: 'Project not found' });
    }
    return;
  }

  // 4. Strict path confinement check (prevents directory traversal attacks)
  const baseUserDir = path.resolve(baseDir, authUid);
  const userProjectDir = path.resolve(baseUserDir, projectId);
  const targetFilePath = path.resolve(userProjectDir, fileName);

  if (!targetFilePath.startsWith(userProjectDir + path.sep) && targetFilePath !== userProjectDir) {
    res.status(403).json({ error: 'Forbidden: Directory traversal attempt blocked' });
    return;
  }

  if (!targetFilePath.startsWith(baseUserDir + path.sep)) {
    res.status(403).json({ error: 'Forbidden: Out-of-bounds file access' });
    return;
  }

  // 5. File existence check
  if (!fs.existsSync(targetFilePath) || !fs.statSync(targetFilePath).isFile()) {
    res.status(404).json({ error: 'Requested file not found' });
    return;
  }

  const stat = fs.statSync(targetFilePath);
  const ext = path.extname(fileName).toLowerCase();
  const mimeType = MIME_TYPE_MAP[ext] || 'application/octet-stream';

  // 6. HTTP Range Requests & Video Seeking Support (Task 11)
  const rangeHeader = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }

    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;

    if (start >= stat.size || end >= stat.size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(chunkSize));
    res.setHeader('Content-Type', mimeType);

    const stream = fs.createReadStream(targetFilePath, { start, end });
    stream.on('error', () => res.end());
    stream.pipe(res);
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Type', mimeType);

    const stream = fs.createReadStream(targetFilePath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  }
}

// Authenticated private media routes with HTTP Range / video seeking support
app.get('/media/uploads/:uid/:projectId/:fileName', requireAuth, async (req: AuthenticatedRequest, res) => {
  await handleSecureMediaStream(req, res, UPLOADS_DIR, 'upload');
});

app.get('/media/audio/:uid/:projectId/:fileName', requireAuth, async (req: AuthenticatedRequest, res) => {
  await handleSecureMediaStream(req, res, AUDIO_DIR, 'audio');
});

app.get('/media/exports/:uid/:projectId/:fileName', requireAuth, async (req: AuthenticatedRequest, res) => {
  await handleSecureMediaStream(req, res, EXPORTS_DIR, 'export');
});

// Reject any unhandled or malformed access to private media directories
app.use(['/media/uploads', '/media/audio', '/media/exports'], requireAuth, (_req, res) => {
  res.status(403).json({ error: 'Forbidden: Invalid media path or access denied' });
});

const uploadStorage = multer.diskStorage({
  destination: (req: AuthenticatedRequest, _file, cb) => {
    // SECURITY: Use verified authenticated UID from token, NEVER trust client-provided body
    const uid = sanitizeId(req.uid || 'unauthorized');
    const projectId = sanitizeId(req.body.projectId || `proj_${Date.now()}`);
    req.body.projectId = projectId;
    const dir = path.join(UPLOADS_DIR, uid, projectId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `video${ext}`);
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // Up to 2 GB
});

const chunkMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max per chunk
});

const fontStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
    cb(null, FONTS_DIR);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, safeName);
  },
});

const fontUploadMiddleware = multer({
  storage: fontStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

/**
 * 1. POST /api/upload-url -> Returns structured storage path & upload endpoint
 * SECURITY: Protected with requireAuth, uses verified req.uid
 */
app.post('/api/upload-url', requireAuth, (req: AuthenticatedRequest, res) => {
  const uid = req.uid!;
  if (!isValidIdentifier(uid)) {
    res.status(400).json({ error: 'Bad Request: Invalid authenticated user identifier' });
    return;
  }
  const projectId = `proj_${Date.now().toString(36)}`;
  const rawName = (req.body?.fileName || 'video.mp4') as string;
  const ext = path.extname(rawName) || '.mp4';
  const safeExt = ['.mp4', '.mov', '.webm', '.m4v'].includes(ext.toLowerCase()) ? ext.toLowerCase() : '.mp4';
  const storagePath = `uploads/${uid}/${projectId}/video${safeExt}`;

  serverProjects.set(projectId, {
    projectId,
    ownerId: uid,
    title: rawName.slice(0, 200),
    videoFilePath: '',
    videoUrl: `/media/${storagePath}`,
    audioFilePath: '',
    audioUrl: '',
    durationSec: 0,
    sizeBytes: 0,
    mimeType: 'video/mp4',
    language: 'km+en',
    wordsPerSegment: 0,
    status: 'uploading',
    segments: [],
  });

  try {
    const dir = path.resolve(UPLOADS_DIR, uid, projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'project.json'),
      JSON.stringify({ projectId, ownerId: uid, title: rawName.slice(0, 200), createdAt: new Date().toISOString() })
    );
  } catch {
    // non-blocking
  }

  res.json({
    projectId,
    storagePath,
    uploadUrl: '/api/projects',
    chunkUploadUrl: '/api/upload-chunk',
    sessionUploadUrl: '/api/upload-session',
    publicUrl: `/media/${storagePath}`,
  });
});

/**
 * 1b. POST /api/upload-session -> Initializes a secure chunked upload session
 * Tracks uploadId, authenticated UID, projectId, expectedSizeBytes, totalChunks, receivedChunks.
 */
app.post('/api/upload-session', requireAuth, (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const uid = req.uid!;
    const { projectId, fileName, expectedSizeBytes, chunkSize, totalChunks } = req.body;

    if (!projectId || !fileName || expectedSizeBytes === undefined || chunkSize === undefined || totalChunks === undefined) {
      res.status(400).json({
        error: 'Missing required session parameters: projectId, fileName, expectedSizeBytes, chunkSize, totalChunks',
      });
      return;
    }

    const session = createUploadSession({
      uid,
      projectId: String(projectId),
      fileName: String(fileName),
      expectedSizeBytes: Number(expectedSizeBytes),
      chunkSize: Number(chunkSize),
      totalChunks: Number(totalChunks),
    });

    res.status(201).json({
      ok: true,
      uploadId: session.uploadId,
      projectId: session.projectId,
      fileName: session.fileName,
      totalChunks: session.totalChunks,
      chunkSize: session.chunkSize,
      expectedSizeBytes: session.expectedSizeBytes,
      expiresAt: session.expiresAt,
    });
  } catch (err: any) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: err.message || 'Failed to initialize upload session' });
  }
});

/**
 * 1c. GET /api/upload-session/:uploadId -> Gets upload session status and received chunks
 */
app.get('/api/upload-session/:uploadId', requireAuth, (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const uid = req.uid!;
    const { uploadId } = req.params;
    const session = getUploadSession(uploadId, uid);
    res.json({
      ok: true,
      uploadId: session.uploadId,
      projectId: session.projectId,
      status: session.status,
      totalChunks: session.totalChunks,
      receivedChunks: Array.from(session.receivedChunks).sort((a, b) => a - b),
      receivedCount: session.receivedChunks.size,
      uploadedBytes: Array.from(session.chunkSizes.values()).reduce((a, b) => a + b, 0),
      expectedSizeBytes: session.expectedSizeBytes,
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Failed to get upload session' });
  }
});

/**
 * 1d. POST /api/upload-session/:uploadId/chunk -> Stores an individual chunk
 * Enforces chunk index validation, duplicate chunk rejection (409), direct-to-disk streaming
 */
app.post(
  '/api/upload-session/:uploadId/chunk',
  requireAuth,
  chunkMemoryUpload.single('chunk'),
  async (req: AuthenticatedRequest, res: ExpressResponse) => {
    try {
      const uid = req.uid!;
      const { uploadId } = req.params;
      const rawIndex = req.body.chunkIndex;

      if (rawIndex === undefined || rawIndex === null || rawIndex === '') {
        res.status(400).json({ error: 'Missing chunkIndex parameter' });
        return;
      }

      const chunkIndex = Number.parseInt(String(rawIndex), 10);
      if (Number.isNaN(chunkIndex)) {
        res.status(400).json({ error: 'chunkIndex must be an integer' });
        return;
      }

      if (!req.file || !req.file.buffer) {
        res.status(400).json({ error: 'Missing chunk binary payload in form-data' });
        return;
      }

      const result = await storeChunk({
        uploadId,
        uid,
        chunkIndex,
        chunkBuffer: req.file.buffer,
      });

      res.json({
        ok: true,
        uploadId,
        chunkIndex,
        receivedCount: result.receivedCount,
        totalChunks: result.totalChunks,
        uploadedBytes: result.uploadedBytes,
      });
    } catch (err: any) {
      const status = err.statusCode || 500;
      res.status(status).json({ error: err.message || 'Failed to process chunk upload' });
    }
  }
);

/**
 * 1e. POST /api/upload-session/:uploadId/complete -> Assembles, verifies container & ffprobe streams, finalizes upload
 */
app.post(
  '/api/upload-session/:uploadId/complete',
  requireAuth,
  async (req: AuthenticatedRequest, res: ExpressResponse) => {
    try {
      const uid = req.uid!;
      const { uploadId } = req.params;

      const completed = await completeUploadSession(uploadId, uid);

      // Register or update project in memory to maintain ownership
      serverProjects.set(completed.projectId, {
        projectId: completed.projectId,
        ownerId: uid,
        title: 'Uploaded Video',
        videoFilePath: completed.videoFilePath,
        videoUrl: completed.videoUrl,
        audioFilePath: '',
        audioUrl: '',
        durationSec: 0,
        sizeBytes: completed.sizeBytes,
        mimeType: completed.mimeType,
        language: 'km+en',
        wordsPerSegment: 0,
        status: 'uploaded',
        segments: [],
      });

      res.json({
        ok: true,
        uploadId,
        projectId: completed.projectId,
        storagePath: completed.storagePath,
        videoUrl: completed.videoUrl,
        sizeBytes: completed.sizeBytes,
        mimeType: completed.mimeType,
        formatName: completed.formatName,
      });
    } catch (err: any) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message || 'Failed to complete upload session',
        missingChunks: err.missingChunks,
      });
    }
  }
);

/**
 * 1f. DELETE /api/upload-session/:uploadId -> Cancels session and removes all staged parts immediately
 */
app.delete(
  '/api/upload-session/:uploadId',
  requireAuth,
  async (req: AuthenticatedRequest, res: ExpressResponse) => {
    try {
      const uid = req.uid!;
      const { uploadId } = req.params;

      const result = await cancelUploadSession(uploadId, uid);
      res.json({
        ok: true,
        uploadId,
        cancelled: result.cancelled,
      });
    } catch (err: any) {
      const status = err.statusCode || 500;
      res.status(status).json({ error: err.message || 'Failed to cancel upload session' });
    }
  }
);

/**
 * Legacy chunk route (backward-compatible adapter)
 */
app.post(
  '/api/upload-chunk',
  requireAuth,
  chunkMemoryUpload.single('chunk'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.uid!;
      const projectId = req.body.projectId;

      if (!isValidIdentifier(uid) || !isValidIdentifier(projectId)) {
        res.status(400).json({ error: 'Bad Request: Invalid identifier format' });
        return;
      }

      const chunkIndex = Number.parseInt(req.body.chunkIndex || '0', 10);
      const totalChunks = Number.parseInt(req.body.totalChunks || '1', 10);
      const rawFileName = (req.body.fileName || 'video.mp4') as string;
      const ext = path.extname(rawFileName) || '.mp4';
      const safeExt = ['.mp4', '.mov', '.webm', '.m4v'].includes(ext.toLowerCase()) ? ext.toLowerCase() : '.mp4';

      if (!req.file) {
        res.status(400).json({ error: 'Missing chunk binary payload' });
        return;
      }

      // Confinement check: directory MUST be inside UPLOADS_DIR/uid
      const baseUserDir = path.resolve(UPLOADS_DIR, uid);
      const dir = path.resolve(baseUserDir, projectId);
      if (!dir.startsWith(baseUserDir + path.sep)) {
        res.status(403).json({ error: 'Forbidden: Path traversal blocked' });
        return;
      }

      // Check if project is registered to another user
      const existingProj = serverProjects.get(projectId);
      if (existingProj && existingProj.ownerId !== uid) {
        res.status(403).json({ error: 'Forbidden: You do not have permission to upload to this project' });
        return;
      }

      fs.mkdirSync(dir, { recursive: true });
      const targetFileName = `video${safeExt}`;
      const targetFilePath = path.resolve(dir, targetFileName);

      if (!targetFilePath.startsWith(dir + path.sep)) {
        res.status(403).json({ error: 'Forbidden: Path traversal blocked' });
        return;
      }

      if (chunkIndex === 0 && fs.existsSync(targetFilePath)) {
        fs.unlinkSync(targetFilePath);
      }

      fs.appendFileSync(targetFilePath, req.file.buffer);
      const stat = fs.statSync(targetFilePath);

      res.json({
        ok: true,
        chunkIndex,
        totalChunks,
        uploadedFileName: targetFileName,
        currentSizeBytes: stat.size,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to write video chunk',
      });
    }
  }
);

/**
 * 1c. POST /api/fonts/upload -> Uploads a custom Khmer .ttf / .otf font file for browser + FFmpeg burn-in
 * SECURITY: Protected with requireAuth
 */
app.post(
  '/api/fonts/upload',
  requireAuth,
  fontUploadMiddleware.single('font'),
  (req: AuthenticatedRequest, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No font file provided' });
        return;
      }
      const fontFamilyName = path
        .basename(req.file.filename, path.extname(req.file.filename))
        .replace(/[-_]/g, ' ');
      const fontUrl = `/media/fonts/${encodeURIComponent(req.file.filename)}`;
      res.json({
        ok: true,
        fontFamilyName,
        fileName: req.file.filename,
        fontUrl,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload custom Khmer font',
      });
    }
  }
);

/**
 * 2. POST /api/projects -> Create project (Chunked Large Video, Direct Upload, Mic Recording, YouTube Link, or Demo Clip)
 * SECURITY: Protected with requireAuth, uses verified req.uid (client uid in body is ignored)
 */
app.post(
  '/api/projects',
  requireAuth,
  uploadMiddleware.single('video'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.uid!;
      const projectId = req.body.projectId || `proj_${Date.now().toString(36)}`;

      if (!isValidIdentifier(uid) || !isValidIdentifier(projectId)) {
        res.status(400).json({ error: 'Bad Request: Invalid identifier format' });
        return;
      }

      // Check if project is registered to another user
      const existingProj = serverProjects.get(projectId);
      if (existingProj && existingProj.ownerId !== uid) {
        res.status(403).json({ error: 'Forbidden: You do not own this project' });
        return;
      }

      const title = (req.body.title || 'Khmer + English Recording').slice(0, 200);
      const language = (req.body.language || 'km+en') as LanguageOption;
      const provider = (req.body.provider || 'gemini') as AsrProvider;
      const rawWords = Number.parseInt(req.body.wordsPerSegment || '0', 10);
      const wordsPerSegment = ([0, 1, 2, 3, 4].includes(rawWords) ? rawWords : 0) as WordsPerSegmentOption;
      const youtubeUrl = (req.body.youtubeUrl || '').trim();
      const uploadedFileName = (req.body.uploadedFileName || '').trim();

      let videoFilePath = '';
      let relativeVideoPath = '';
      let durationSec = 18.0;
      let sizeBytes = 0;
      let mimeType = req.body.mimeType || 'video/mp4';

      const baseUserDir = path.resolve(UPLOADS_DIR, uid);
      const userProjectDir = path.resolve(baseUserDir, projectId);
      if (!userProjectDir.startsWith(baseUserDir + path.sep)) {
        res.status(403).json({ error: 'Forbidden: Path traversal blocked' });
        return;
      }

      const preUploadedPath = uploadedFileName && isValidFileName(uploadedFileName)
        ? path.resolve(userProjectDir, path.basename(uploadedFileName))
        : '';

      const hasPreUploadedFile = Boolean(
        preUploadedPath &&
        preUploadedPath.startsWith(userProjectDir + path.sep) &&
        fs.existsSync(preUploadedPath)
      );
      const useDemoClip =
        req.body.useDemoClip === 'true' ||
        Boolean(youtubeUrl) ||
        (!req.file && !hasPreUploadedFile);

      if (hasPreUploadedFile) {
        videoFilePath = preUploadedPath;
        relativeVideoPath = `uploads/${uid}/${projectId}/${path.basename(uploadedFileName)}`;
        sizeBytes = fs.statSync(preUploadedPath).size;
        durationSec = await probeVideoDuration(videoFilePath);
      } else if (req.file) {
        videoFilePath = req.file.path;
        relativeVideoPath = `uploads/${uid}/${projectId}/${req.file.filename}`;
        sizeBytes = req.file.size;
        mimeType = req.file.mimetype || 'video/mp4';
        durationSec = await probeVideoDuration(videoFilePath);
      } else {
        const demo = await ensureDemoVideoClip(uid, projectId);
        videoFilePath = demo.videoFilePath;
        relativeVideoPath = demo.relativeVideoPath;
        durationSec = demo.durationSec;
        sizeBytes = demo.sizeBytes;
      }

      const videoUrl = `/media/${relativeVideoPath}`;
      const jobId = `job_${Date.now().toString(36)}`;

      const initialJob: JobRecord = {
        id: jobId,
        ownerId: uid,
        projectId,
        type: 'transcribe',
        status: 'running',
        progress: 0.16,
        step: 'extract_audio',
        provider,
        error: '',
        attempts: 1,
      };
      serverJobs.set(jobId, initialJob);

      serverProjects.set(projectId, {
        projectId,
        ownerId: uid,
        title,
        videoFilePath,
        videoUrl,
        audioFilePath: '',
        audioUrl: '',
        durationSec,
        sizeBytes,
        mimeType,
        language,
        wordsPerSegment,
        status: 'transcribing',
        segments: [],
      });

      try {
        fs.mkdirSync(userProjectDir, { recursive: true });
        fs.writeFileSync(
          path.join(userProjectDir, 'project.json'),
          JSON.stringify({ projectId, ownerId: uid, title, createdAt: new Date().toISOString() })
        );
      } catch {
        // non-blocking
      }

      (async () => {
        try {
          const { audioFilePath, audioMp3Path, relativeAudioPath, hasRealAudio } =
            await extractAudioToWav(videoFilePath, uid, projectId);
          const projState = serverProjects.get(projectId);
          if (projState) {
            projState.audioFilePath = audioFilePath;
            projState.audioUrl = `/media/${relativeAudioPath}`;
          }

          serverJobs.set(jobId, {
            ...initialJob,
            status: 'running',
            progress: 0.42,
            step: 'asr',
          });

          const segments = await transcribeAudioWithGemini({
            audioFilePath,
            audioMp3Path,
            projectId,
            ownerId: uid,
            language,
            durationSec,
            wordsPerSegment,
            isDemoClip: useDemoClip,
            hasRealAudio,
            onProgress: (prog) => {
              serverJobs.set(jobId, {
                ...initialJob,
                status: 'running',
                progress: prog,
                step: 'asr',
              });
            },
          });

          serverJobs.set(jobId, {
            ...initialJob,
            status: 'running',
            progress: 0.88,
            step: 'postprocess',
          });

          await new Promise((r) => setTimeout(r, 350));

          if (projState) {
            projState.segments = segments;
            projState.status = 'ready';
          }

          serverJobs.set(jobId, {
            ...initialJob,
            status: 'done',
            progress: 1.0,
            step: 'completed',
            resultSegments: segments,
          });
        } catch (workerErr) {
          const message =
            workerErr instanceof Error ? workerErr.message : 'Transcription pipeline failed';
          serverJobs.set(jobId, {
            ...initialJob,
            status: 'failed',
            progress: 1.0,
            step: 'completed',
            error: message,
          });
          const projState = serverProjects.get(projectId);
          if (projState) projState.status = 'failed';
        }
      })();

      res.json({
        projectId,
        jobId,
        videoUrl,
        storagePath: relativeVideoPath,
        durationSec,
        sizeBytes,
        mimeType,
        wordsPerSegment,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to start project pipeline',
      });
    }
  }
);

/**
 * 2b. GET /api/projects -> List all projects belonging to the authenticated user
 * SECURITY: Protected with requireAuth, filters exclusively by req.uid
 */
app.get('/api/projects', requireAuth, (req: AuthenticatedRequest, res) => {
  const uid = sanitizeId(req.uid!);
  const userProjects: Array<{
    projectId: string;
    ownerId: string;
    title: string;
    videoUrl: string;
    audioUrl: string;
    durationSec: number;
    sizeBytes: number;
    mimeType: string;
    language: LanguageOption;
    wordsPerSegment: WordsPerSegmentOption;
    status: string;
    segmentCount: number;
  }> = [];

  for (const proj of serverProjects.values()) {
    if (proj.ownerId === uid) {
      userProjects.push({
        projectId: proj.projectId,
        ownerId: proj.ownerId,
        title: proj.title,
        videoUrl: proj.videoUrl,
        audioUrl: proj.audioUrl,
        durationSec: proj.durationSec,
        sizeBytes: proj.sizeBytes,
        mimeType: proj.mimeType,
        language: proj.language,
        wordsPerSegment: proj.wordsPerSegment,
        status: proj.status,
        segmentCount: proj.segments.length,
      });
    }
  }

  res.json({ projects: userProjects });
});

/**
 * 3. GET /api/projects/:id -> Project + segments
 * SECURITY: Protected with requireAuth, verifies user owns the project (HTTP 403 on mismatch)
 */
/**
 * 3. GET /api/projects/:id -> Project + segments
 * SECURITY: Protected with requireAuth, verifies user owns the project against the database (HTTP 403 on mismatch)
 */
app.get('/api/projects/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const projectId = req.params.id;
  const uid = req.uid!;

  if (!isValidIdentifier(projectId)) {
    res.status(400).json({ error: 'Bad Request: Invalid projectId format' });
    return;
  }

  const ownership = await verifyProjectOwnership(uid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({ error: 'Forbidden: You do not have permission to access this project' });
    } else {
      res.status(404).json({ error: 'Project not found' });
    }
    return;
  }

  const proj = serverProjects.get(projectId);
  if (proj) {
    res.json({
      projectId: proj.projectId,
      ownerId: proj.ownerId,
      videoUrl: proj.videoUrl,
      audioUrl: proj.audioUrl,
      status: proj.status,
      segments: proj.segments,
      wordsPerSegment: proj.wordsPerSegment,
    });
    return;
  }

  // If owned by user but not in server cache, return ready state
  res.json({
    projectId,
    ownerId: uid,
    videoUrl: `/media/uploads/${uid}/${projectId}/video.mp4`,
    audioUrl: `/media/audio/${uid}/${projectId}/audio.wav`,
    status: 'ready',
    segments: [],
  });
});

/**
 * 3b. DELETE /api/projects/:id -> Delete project and files
 * SECURITY: Protected with requireAuth, verifies user owns the project (HTTP 403 on mismatch)
 */
app.delete('/api/projects/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const projectId = req.params.id;
  const uid = req.uid!;

  if (!isValidIdentifier(projectId)) {
    res.status(400).json({ error: 'Bad Request: Invalid projectId format' });
    return;
  }

  const ownership = await verifyProjectOwnership(uid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({ error: 'Forbidden: You do not have permission to delete this project' });
    } else {
      res.status(404).json({ error: 'Project not found' });
    }
    return;
  }

  serverProjects.delete(projectId);

  // Clean up user files strictly within user's own directories
  const baseUpload = path.resolve(UPLOADS_DIR, uid);
  const baseAudio = path.resolve(AUDIO_DIR, uid);
  const baseExport = path.resolve(EXPORTS_DIR, uid);

  const userUploadDir = path.resolve(baseUpload, projectId);
  const userAudioDir = path.resolve(baseAudio, projectId);
  const userExportDir = path.resolve(baseExport, projectId);

  [
    { dir: userUploadDir, base: baseUpload },
    { dir: userAudioDir, base: baseAudio },
    { dir: userExportDir, base: baseExport },
  ].forEach(({ dir, base }) => {
    try {
      if (dir.startsWith(base + path.sep) && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Non-blocking cleanup
    }
  });

  res.json({ ok: true, projectId });
});

/**
 * 4. GET /api/jobs/:id -> Poll job progress status
 * SECURITY: Protected with requireAuth, verifies user owns the job (HTTP 403 on mismatch)
 */
app.get('/api/jobs/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const jobId = req.params.id;
  const uid = req.uid!;

  if (!isValidIdentifier(jobId)) {
    res.status(400).json({ error: 'Bad Request: Invalid jobId format' });
    return;
  }

  const job = serverJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  if (job.ownerId !== uid) {
    res.status(403).json({ error: 'Forbidden: You do not have permission to access this job' });
    return;
  }

  res.json(job);
});

/**
 * 5. PUT /api/projects/:id/segments -> Save edited segments on server
 * SECURITY: Protected with requireAuth, verifies user owns the project against the database
 */
app.put('/api/projects/:id/segments', requireAuth, async (req: AuthenticatedRequest, res) => {
  const projectId = req.params.id;
  const uid = req.uid!;

  if (!isValidIdentifier(projectId)) {
    res.status(400).json({ error: 'Bad Request: Invalid projectId format' });
    return;
  }

  const ownership = await verifyProjectOwnership(uid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({ error: 'Forbidden: You do not have permission to edit this project' });
    } else {
      res.status(404).json({ error: 'Project not found' });
    }
    return;
  }

  const segments = Array.isArray(req.body?.segments)
    ? (req.body.segments as SubtitleSegment[])
    : [];
  const proj = serverProjects.get(projectId);

  if (proj) {
    proj.segments = segments;
  }

  res.json({ ok: true, count: segments.length });
});

/**
 * 1. findProjectVideoFile()
 * Finds the uploaded video file for a projectId within the authenticated user's directory.
 * SECURITY:
 * - Scoped strictly to the authenticated user directory
 * - Cross-user directory searching is COMPLETELY REMOVED
 * - Directory traversal prevented via strict identifier validation & path confinement checks
 */
export function findProjectVideoFile(uid: string, projectId: string): string | null {
  if (!isValidIdentifier(uid) || !isValidIdentifier(projectId)) {
    return null;
  }

  const baseUserDir = path.resolve(UPLOADS_DIR, uid);
  const userProjectDir = path.resolve(baseUserDir, projectId);

  // Confinement check: userProjectDir MUST be inside baseUserDir
  if (!userProjectDir.startsWith(baseUserDir + path.sep)) {
    return null;
  }

  // 1. In-memory check - only if owned by this uid and path is verified within userProjectDir
  const inMemory = serverProjects.get(projectId);
  if (
    inMemory &&
    inMemory.ownerId === uid &&
    inMemory.videoFilePath &&
    path.resolve(inMemory.videoFilePath).startsWith(userProjectDir + path.sep) &&
    fs.existsSync(inMemory.videoFilePath)
  ) {
    return inMemory.videoFilePath;
  }

  // 2. Scan strictly inside the user's own project directory
  if (fs.existsSync(userProjectDir) && fs.statSync(userProjectDir).isDirectory()) {
    const files = fs.readdirSync(userProjectDir);
    const vidFile = files.find(
      (f) =>
        isValidFileName(f) &&
        (f.startsWith('video') || f.endsWith('.mp4') || f.endsWith('.mov') || f.endsWith('.webm'))
    );
    if (vidFile) {
      const candidate = path.resolve(userProjectDir, vidFile);
      if (candidate.startsWith(userProjectDir + path.sep) && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // NOTE: ABSOLUTELY NO SEARCHING OTHER USERS' DIRECTORIES!
  return null;
}
export const findUserProjectVideoFile = findProjectVideoFile;

const EXPORT_EXT_MAP: Record<ExportFormat, { fileName: string; mime: string }> = {
  srt: { fileName: 'subs.srt', mime: 'text/plain; charset=utf-8' },
  vtt: { fileName: 'subs.vtt', mime: 'text/vtt; charset=utf-8' },
  txt: { fileName: 'subs.txt', mime: 'text/plain; charset=utf-8' },
  markdown: { fileName: 'subs.md', mime: 'text/markdown; charset=utf-8' },
  word: { fileName: 'subs.doc', mime: 'application/msword; charset=utf-8' },
  pdf: { fileName: 'subs.html', mime: 'text/html; charset=utf-8' },
  burn: { fileName: 'burned.mp4', mime: 'video/mp4' },
};

/**
 * 2. resolveExportFilePath()
 * Resolves an exported file path scoped strictly to the authenticated user.
 * SECURITY:
 * - Scoped strictly to exports/:uid/:projectId
 * - Cross-user directory searching is COMPLETELY REMOVED
 * - Directory traversal prevented via strict identifier validation & path confinement checks
 */
export function resolveExportFilePath(
  uid: string,
  projectId: string,
  format: ExportFormat
): string | null {
  if (!isValidIdentifier(uid) || !isValidIdentifier(projectId)) {
    return null;
  }

  const meta = EXPORT_EXT_MAP[format] || EXPORT_EXT_MAP.srt;
  if (!meta || !isValidFileName(meta.fileName)) {
    return null;
  }

  const baseExportDir = path.resolve(EXPORTS_DIR, uid);
  const userExportDir = path.resolve(baseExportDir, projectId);

  // Confinement check: userExportDir MUST be inside baseExportDir
  if (!userExportDir.startsWith(baseExportDir + path.sep)) {
    return null;
  }

  // 1. Check direct file in user's export directory
  const directCandidate = path.resolve(userExportDir, meta.fileName);
  if (
    directCandidate.startsWith(userExportDir + path.sep) &&
    fs.existsSync(directCandidate) &&
    fs.statSync(directCandidate).isFile()
  ) {
    return directCandidate;
  }

  // 2. In-memory check - only accept if owner matches authenticated uid and path is inside userExportDir
  const proj = serverProjects.get(projectId);
  if (
    proj &&
    proj.ownerId === uid &&
    proj.latestDownloadPath &&
    proj.latestDownloadFormat === format &&
    path.resolve(proj.latestDownloadPath).startsWith(userExportDir + path.sep) &&
    fs.existsSync(proj.latestDownloadPath)
  ) {
    return proj.latestDownloadPath;
  }

  // 3. If text/doc file not generated yet, write it on demand scoped strictly to this user
  if (format !== 'burn') {
    const segs = proj?.segments || [];
    if (segs.length > 0) {
      const { filePath } = writeSubtitleExportFile({
        uid,
        projectId,
        title: proj?.title || projectId,
        format,
        segments: segs,
        wordsPerSegment: 0,
      });
      const resolved = path.resolve(filePath);
      if (resolved.startsWith(userExportDir + path.sep) && fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }

  // NOTE: ABSOLUTELY NO SEARCHING OTHER USERS' DIRECTORIES!
  return null;
}
export const resolveUserExportFilePath = resolveExportFilePath;

/**
 * 6. POST /api/projects/:id/export -> Export SRT / VTT / TXT / Markdown / Word / PDF or Burned-in Video
 * SECURITY: Protected with requireAuth, uses verified req.uid (client uid in body is ignored)
 */
app.post('/api/projects/:id/export', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid!;

    if (!isValidIdentifier(projectId)) {
      res.status(400).json({ error: 'Bad Request: Invalid projectId format' });
      return;
    }

    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: 'Forbidden: You do not have permission to export this project' });
      } else {
        res.status(404).json({ error: 'Project not found' });
      }
      return;
    }

    const format = (req.body?.format || 'srt') as ExportFormat;
    const bodySegments: SubtitleSegment[] = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const proj = serverProjects.get(projectId);

    const segments: SubtitleSegment[] =
      bodySegments.length > 0 ? bodySegments : proj?.segments || [];

    // Save exact current segments into server project memory
    if (proj && segments.length > 0) {
      proj.segments = segments;
    }

    const template: CaptionTemplate | undefined = req.body?.template;
    const rawWps = Number.parseInt(String(req.body?.wordsPerSegment ?? '0'), 10);
    const wordsPerSegment = ([0, 1, 2, 3, 4].includes(rawWps) ? rawWps : 0) as WordsPerSegmentOption;

    const jobId = `job_exp_${Date.now().toString(36)}`;
    const exportId = `exp_${Date.now().toString(36)}`;

    if (format !== 'burn') {
      const { filePath, relativeOutputPath } = writeSubtitleExportFile({
        uid,
        projectId,
        title: proj?.title || projectId,
        format,
        segments,
        wordsPerSegment,
      });

      if (proj) {
        proj.latestDownloadPath = filePath;
        proj.latestDownloadFormat = format;
      }

      const stat = fs.statSync(filePath);
      const downloadUrl = `/api/projects/${projectId}/download?format=${format}`;
      res.json({
        jobId,
        exportId,
        format,
        outputPath: relativeOutputPath,
        downloadUrl,
        fontUsed: 'none',
        sizeBytes: stat.size,
      });
      return;
    }

    let videoFilePath = findUserProjectVideoFile(uid, projectId);
    if (!videoFilePath || !fs.existsSync(videoFilePath)) {
      const demo = await ensureDemoVideoClip(uid, projectId);
      videoFilePath = demo.videoFilePath;
    }

    const { burnedFilePath, relativeOutputPath, fontUsed, sizeBytes } =
      await burnSubtitlesWithFfmpeg({
        videoFilePath,
        uid,
        projectId,
        segments,
        template,
        wordsPerSegment,
      });

    if (proj) {
      proj.latestDownloadPath = burnedFilePath;
      proj.latestDownloadFormat = 'burn';
    }

    const downloadUrl = `/api/projects/${projectId}/download?format=burn`;
    res.json({
      jobId,
      exportId,
      format: 'burn',
      outputPath: relativeOutputPath,
      downloadUrl,
      fontUsed,
      sizeBytes,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to export subtitles',
    });
  }
});

/**
 * 6b. GET /api/projects/:id/download-info -> Returns file size & MIME metadata for chunked downloading
 * SECURITY: Protected with requireAuth, enforces access strictly to verified req.uid
 */
/**
 * 6b. GET /api/projects/:id/download-info -> Returns file size & MIME metadata for chunked downloading
 * SECURITY: Protected with requireAuth, verifies project ownership against the database
 */
app.get('/api/projects/:id/download-info', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid!;

    if (!isValidIdentifier(projectId)) {
      res.status(400).json({ error: 'Bad Request: Invalid projectId format' });
      return;
    }

    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: 'Forbidden: You do not have permission to access this project' });
      } else {
        res.status(404).json({ error: 'Project not found' });
      }
      return;
    }

    const format = ((req.query.format as string) || 'burn') as ExportFormat;
    const meta = EXPORT_EXT_MAP[format] || EXPORT_EXT_MAP.burn;

    const targetPath = resolveExportFilePath(uid, projectId, format);
    if (!targetPath || !fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Exported file not found. Please run export first.' });
      return;
    }

    const stat = fs.statSync(targetPath);
    const downloadName =
      format === 'burn' ? `${projectId}_khmer_subtitled.mp4` : `${projectId}_${meta.fileName}`;

    res.json({
      ok: true,
      projectId,
      format,
      sizeBytes: stat.size,
      mime: meta.mime,
      fileName: meta.fileName,
      downloadName,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read download info',
    });
  }
});

/**
 * 6c. GET /api/projects/:id/download-chunk -> Streams a 4MB binary slice of an exported file.
 * SECURITY: Protected with requireAuth, verifies user owns the project/file against the database
 */
app.get('/api/projects/:id/download-chunk', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid!;

    if (!isValidIdentifier(projectId)) {
      res.status(400).json({ error: 'Bad Request: Invalid projectId format' });
      return;
    }

    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: 'Forbidden: You do not have permission to access this project' });
      } else {
        res.status(404).json({ error: 'Project not found' });
      }
      return;
    }

    const format = ((req.query.format as string) || 'burn') as ExportFormat;
    const offset = Math.max(0, Number.parseInt((req.query.offset as string) || '0', 10) || 0);
    const requestedLen =
      Number.parseInt((req.query.length as string) || String(4 * 1024 * 1024), 10) ||
      4 * 1024 * 1024;
    const length = Math.max(64 * 1024, Math.min(8 * 1024 * 1024, requestedLen));

    const targetPath = resolveExportFilePath(uid, projectId, format);
    if (!targetPath || !fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Exported file not found' });
      return;
    }

    const stat = fs.statSync(targetPath);
    if (offset >= stat.size) {
      res.status(200).end(Buffer.alloc(0));
      return;
    }

    const bytesToRead = Math.min(length, stat.size - offset);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const fd = fs.openSync(targetPath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
    } finally {
      fs.closeSync(fd);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(bytesRead));
    res.setHeader('X-Total-Size', String(stat.size));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read file chunk',
    });
  }
});

/**
 * 7. GET /api/projects/:id/download -> Stream exported file with HTTP Range & UTF-8 Content-Type support
 * SECURITY: Protected with requireAuth, verifies user owns the project/file against the database
 */
app.get('/api/projects/:id/download', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid!;

    if (!isValidIdentifier(projectId)) {
      res.status(400).json({ error: 'Bad Request: Invalid projectId format' });
      return;
    }

    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: 'Forbidden: You do not have permission to access this project' });
      } else {
        res.status(404).json({ error: 'Project not found' });
      }
      return;
    }

    const format = ((req.query.format as string) || 'srt') as ExportFormat;
    const meta = EXPORT_EXT_MAP[format] || EXPORT_EXT_MAP.srt;

    const targetPath = resolveExportFilePath(uid, projectId, format);
    if (!targetPath || !fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Exported file not found. Please run export first.' });
      return;
    }

    const downloadName =
      format === 'burn' ? `${projectId}_khmer_subtitled.mp4` : `${projectId}_${meta.fileName}`;
    const stat = fs.statSync(targetPath);
    const rangeHeader = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(parts[0], 10);
      const end = parts[1] ? Number.parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', String(chunkSize));
      res.setHeader('Content-Type', meta.mime);
      const stream = fs.createReadStream(targetPath, { start, end });
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }

    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    const stream = fs.createReadStream(targetPath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Download stream error',
    });
  }
});

/**
 * 8. POST /api/ai/analyze -> Generate AI Summary, Key Themes, Key Quotes, and Mind Map
 * SECURITY: Protected with requireAuth
 */
app.post('/api/ai/analyze', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const title = (req.body?.title || 'Transcript').slice(0, 200);
    const segments: SubtitleSegment[] = Array.isArray(req.body?.segments)
      ? req.body.segments
      : [];
    const result = await generateAiTranscriptAnalysis(title, segments);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to analyze transcript',
    });
  }
});

/**
 * 9. POST /api/ai/chat -> Chat with your transcript
 * SECURITY: Protected with requireAuth
 */
app.post('/api/ai/chat', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const question = (req.body?.question || '').slice(0, 500);
    const segments: SubtitleSegment[] = Array.isArray(req.body?.segments)
      ? req.body.segments
      : [];
    const answer = await chatWithTranscriptGemini({ question, segments });
    res.json({ answer });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to answer question',
    });
  }
});

/**
 * 10. POST /api/ai/translate -> Translate transcript Khmer <-> English
 * SECURITY: Protected with requireAuth
 */
app.post('/api/ai/translate', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const targetLang = req.body?.targetLang === 'en' ? 'en' : 'km';
    const segments: SubtitleSegment[] = Array.isArray(req.body?.segments)
      ? req.body.segments
      : [];
    const translated = await translateSegmentsGemini({ segments, targetLang });
    res.json({ segments: translated });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Translation failed',
    });
  }
});

let serverInstance: ReturnType<typeof app.listen> | null = null;
let isShuttingDown = false;

export async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Lifecycle] Received ${signal}. Starting graceful shutdown...`);

  // Hard timeout so hanging connections do not prevent container shutdown
  const forceExitTimer = setTimeout(() => {
    console.error('[Lifecycle] Shutdown timed out after 10s. Forcing exit.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  if (serverInstance) {
    serverInstance.close((err) => {
      if (err) {
        console.error('[Lifecycle] Error during server close:', err);
        process.exit(1);
      }
      console.log('[Lifecycle] HTTP server closed cleanly. Process exiting.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception occurred:', err);
  if (process.env.NODE_ENV === 'production') {
    gracefulShutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled promise rejection at:', promise, 'reason:', reason);
});

export async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Development mode: Vite dev server middleware with HMR
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Production mode: Serve optimized frontend static bundles
    const candidateDirs = [
      path.join(process.cwd(), 'dist', 'client'),
      path.join(process.cwd(), 'dist'),
    ];
    const clientDistPath =
      candidateDirs.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ||
      candidateDirs[0];

    app.use(
      express.static(clientDistPath, {
        maxAge: '1h',
        index: false,
      })
    );

    // Unmatched API requests return JSON 404 instead of HTML
    app.all('/api/*', (_req, res) => {
      res.status(404).json({ error: 'API endpoint not found' });
    });

    // SPA fallback: Serve index.html for client-side navigation (skipping /api and /media)
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) {
        return next();
      }
      const indexPath = path.join(clientDistPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res
          .status(404)
          .send('Frontend production build not found. Please run npm run build first.');
      }
    });
  }

  serverInstance = app.listen(PORT, HOST, () => {
    console.log(
      `Khmersub Studio server running on http://${HOST}:${PORT} [mode: ${process.env.NODE_ENV || 'development'}]`
    );
  });

  return serverInstance;
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}
