import express from 'express';
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

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));

// Serve uploaded videos, extracted audio, exported SRT/VTT/MP4 files, and Khmer fonts
app.use('/media/uploads', express.static(UPLOADS_DIR));
app.use('/media/audio', express.static(AUDIO_DIR));
app.use('/media/exports', express.static(EXPORTS_DIR));
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

const uploadStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const uid = sanitizeId(req.body.uid || 'anonymous');
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
 */
app.post('/api/upload-url', (req, res) => {
  const uid = sanitizeId(req.body?.uid || 'user');
  const projectId = `proj_${Date.now().toString(36)}`;
  const rawName = (req.body?.fileName || 'video.mp4') as string;
  const ext = path.extname(rawName) || '.mp4';
  const storagePath = `uploads/${uid}/${projectId}/video${ext}`;
  res.json({
    projectId,
    storagePath,
    uploadUrl: '/api/projects',
    chunkUploadUrl: '/api/upload-chunk',
    publicUrl: `/media/${storagePath}`,
  });
});

/**
 * 1b. POST /api/upload-chunk -> Appends a binary chunk for large video uploads (100MB - 2GB+)
 * Bypasses Cloud Run single-request 32MB body limits by streaming 4MB slices sequentially.
 */
app.post('/api/upload-chunk', chunkMemoryUpload.single('chunk'), (req, res) => {
  try {
    const uid = sanitizeId(req.body.uid || 'user');
    const projectId = sanitizeId(req.body.projectId || 'proj_default');
    const chunkIndex = Number.parseInt(req.body.chunkIndex || '0', 10);
    const totalChunks = Number.parseInt(req.body.totalChunks || '1', 10);
    const rawFileName = (req.body.fileName || 'video.mp4') as string;
    const ext = path.extname(rawFileName) || '.mp4';

    if (!req.file) {
      res.status(400).json({ error: 'Missing chunk binary payload' });
      return;
    }

    const dir = path.join(UPLOADS_DIR, uid, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const targetFileName = `video${ext}`;
    const targetFilePath = path.join(dir, targetFileName);

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
});

/**
 * 1c. POST /api/fonts/upload -> Uploads a custom Khmer .ttf / .otf font file for browser + FFmpeg burn-in
 */
app.post('/api/fonts/upload', fontUploadMiddleware.single('font'), (req, res) => {
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
});

/**
 * 2. POST /api/projects -> Create project (Chunked Large Video, Direct Upload, Mic Recording, YouTube Link, or Demo Clip)
 */
app.post('/api/projects', uploadMiddleware.single('video'), async (req, res) => {
  try {
    const uid = sanitizeId(req.body.uid || 'user');
    const projectId = sanitizeId(req.body.projectId || `proj_${Date.now().toString(36)}`);
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

    const preUploadedPath = uploadedFileName
      ? path.join(UPLOADS_DIR, uid, projectId, path.basename(uploadedFileName))
      : '';

    const hasPreUploadedFile = Boolean(preUploadedPath && fs.existsSync(preUploadedPath));
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
});

/**
 * 3. GET /api/projects/:id -> Project + segments
 */
app.get('/api/projects/:id', (req, res) => {
  const projectId = sanitizeId(req.params.id);
  const proj = serverProjects.get(projectId);
  if (!proj) {
    res.json({
      projectId,
      videoUrl: '',
      audioUrl: '',
      status: 'ready',
      segments: [],
    });
    return;
  }
  res.json({
    projectId: proj.projectId,
    videoUrl: proj.videoUrl,
    audioUrl: proj.audioUrl,
    status: proj.status,
    segments: proj.segments,
    wordsPerSegment: proj.wordsPerSegment,
  });
});

/**
 * 4. GET /api/jobs/:id -> Poll job progress status
 */
app.get('/api/jobs/:id', (req, res) => {
  const jobId = sanitizeId(req.params.id);
  const job = serverJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

/**
 * 5. PUT /api/projects/:id/segments -> Save edited segments on server
 */
app.put('/api/projects/:id/segments', (req, res) => {
  const projectId = sanitizeId(req.params.id);
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
 * Helper: Finds the uploaded video file for a projectId across uid or any existing user folder in UPLOADS_DIR
 */
function findProjectVideoFile(uid: string, projectId: string): string | null {
  const inMemory = serverProjects.get(projectId)?.videoFilePath;
  if (inMemory && fs.existsSync(inMemory)) {
    return inMemory;
  }

  const candidateDirs: string[] = [path.join(UPLOADS_DIR, uid, projectId)];
  if (fs.existsSync(UPLOADS_DIR)) {
    for (const userFolder of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, userFolder, projectId);
      if (!candidateDirs.includes(p)) {
        candidateDirs.push(p);
      }
    }
  }

  for (const dir of candidateDirs) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const files = fs.readdirSync(dir);
      const vidFile = files.find((f) => f.startsWith('video'));
      if (vidFile) {
        return path.join(dir, vidFile);
      }
    }
  }

  return null;
}

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
 * Helper: Finds an exported file for a projectId across uid or any existing user folder in EXPORTS_DIR
 */
function resolveExportFilePath(uid: string, projectId: string, format: ExportFormat): string | null {
  const meta = EXPORT_EXT_MAP[format] || EXPORT_EXT_MAP.srt;
  const directCandidate = path.join(EXPORTS_DIR, uid, projectId, meta.fileName);
  if (fs.existsSync(directCandidate)) {
    return directCandidate;
  }

  const proj = serverProjects.get(projectId);
  if (
    proj?.latestDownloadPath &&
    proj.latestDownloadFormat === format &&
    fs.existsSync(proj.latestDownloadPath)
  ) {
    return proj.latestDownloadPath;
  }

  if (fs.existsSync(EXPORTS_DIR)) {
    for (const userFolder of fs.readdirSync(EXPORTS_DIR)) {
      const candidate = path.join(EXPORTS_DIR, userFolder, projectId, meta.fileName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // If text/doc file not generated yet, write it on demand using current server segments
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
      return filePath;
    }
  }

  return null;
}

/**
 * 6. POST /api/projects/:id/export -> Export SRT / VTT / TXT / Markdown / Word / PDF or Burned-in Video
 */
app.post('/api/projects/:id/export', async (req, res) => {
  try {
    const projectId = sanitizeId(req.params.id);
    const uid = sanitizeId(req.body?.uid || 'user');
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
        title: serverProjects.get(projectId)?.title || projectId,
        format,
        segments,
        wordsPerSegment,
      });

      if (proj) {
        proj.latestDownloadPath = filePath;
        proj.latestDownloadFormat = format;
      }

      const stat = fs.statSync(filePath);
      const downloadUrl = `/api/projects/${projectId}/download?format=${format}&uid=${uid}`;
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

    let videoFilePath = findProjectVideoFile(uid, projectId);
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

    const downloadUrl = `/api/projects/${projectId}/download?format=burn&uid=${uid}`;
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
 */
app.get('/api/projects/:id/download-info', (req, res) => {
  try {
    const projectId = sanitizeId(req.params.id);
    const uid = sanitizeId((req.query.uid as string) || 'user');
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
 * Bypasses Cloud Run's 32MB HTTP response payload limit so even 100MB-500MB+ videos download with zero 500 errors.
 */
app.get('/api/projects/:id/download-chunk', (req, res) => {
  try {
    const projectId = sanitizeId(req.params.id);
    const uid = sanitizeId((req.query.uid as string) || 'user');
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
 */
app.get('/api/projects/:id/download', (req, res) => {
  try {
    const projectId = sanitizeId(req.params.id);
    const uid = sanitizeId((req.query.uid as string) || 'user');
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
 */
app.post('/api/ai/analyze', async (req, res) => {
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
 */
app.post('/api/ai/chat', async (req, res) => {
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
 */
app.post('/api/ai/translate', async (req, res) => {
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

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Khmersub Studio server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
