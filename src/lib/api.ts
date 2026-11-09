import {
  SubtitleSegment,
  LanguageOption,
  AsrProvider,
  ExportFormat,
  CaptionTemplate,
  JobRecord,
  AiAnalysisResult,
  WordsPerSegmentOption,
} from '../../shared/segment.schema';
import { auth } from './firebase';

export interface UploadUrlResponse {
  uploadUrl: string;
  chunkUploadUrl?: string;
  storagePath: string;
  publicUrl: string;
  projectId: string;
}

export interface CreateProjectResponse {
  projectId: string;
  jobId: string;
  videoUrl: string;
  storagePath: string;
  durationSec: number;
  sizeBytes: number;
  mimeType: string;
  wordsPerSegment?: WordsPerSegmentOption;
}

/**
 * Retrieves the current Firebase Auth ID token if a user is logged in.
 * If auth hasn't initialized yet, waits for the initial state.
 */
export async function getAuthToken(): Promise<string | null> {
  const currentUser = auth.currentUser;
  if (currentUser) {
    try {
      return await currentUser.getIdToken();
    } catch {
      return null;
    }
  }

  // Wait briefly for auth to initialize if needed
  return new Promise((resolve) => {
    let resolved = false;
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        if (user) {
          try {
            const token = await user.getIdToken();
            resolve(token);
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      }
    });

    // Timeout after 1.5 seconds if auth state does not change
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        resolve(null);
      }
    }, 1500);
  });
}

/**
 * Builds standard headers with Authorization: Bearer <token>
 */
export async function buildAuthHeaders(customHeaders: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...customHeaders };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Appends token query parameter to URLs when needed (for binary streams or static links)
 */
export async function appendAuthTokenToUrl(url: string): Promise<string> {
  const token = await getAuthToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export async function requestUploadUrl(params: {
  uid?: string;
  fileName: string;
  mimeType: string;
}): Promise<UploadUrlResponse> {
  const headers = await buildAuthHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch('/api/upload-url', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to get upload URL' }));
    throw new Error(err.error || `Failed to get upload URL (${res.status})`);
  }
  return res.json();
}

export interface UploadSessionInfo {
  uploadId: string;
  projectId: string;
  fileName: string;
  totalChunks: number;
  chunkSize: number;
  expectedSizeBytes: number;
  expiresAt: number;
}

export async function createUploadSessionApi(params: {
  projectId: string;
  fileName: string;
  expectedSizeBytes: number;
  chunkSize: number;
  totalChunks: number;
}): Promise<UploadSessionInfo> {
  const headers = await buildAuthHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch('/api/upload-session', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to create upload session' }));
    throw new Error(err.error || `Failed to create upload session (${res.status})`);
  }
  return res.json();
}

export async function uploadSessionChunkApi(params: {
  uploadId: string;
  chunkIndex: number;
  chunkBlob: Blob;
  fileName: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; receivedCount: number; totalChunks: number; uploadedBytes: number }> {
  const headers = await buildAuthHeaders();
  const form = new FormData();
  form.append('chunkIndex', String(params.chunkIndex));
  form.append('chunk', params.chunkBlob, params.fileName);

  const res = await fetch(`/api/upload-session/${encodeURIComponent(params.uploadId)}/chunk`, {
    method: 'POST',
    headers,
    body: form,
    signal: params.signal,
  });

  if (res.status === 409) {
    // 409 Conflict: Chunk already uploaded, idempotent success
    return { ok: true, receivedCount: params.chunkIndex + 1, totalChunks: -1, uploadedBytes: 0 };
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to upload chunk' }));
    throw new Error(err.error || `Chunk ${params.chunkIndex} upload failed with status ${res.status}`);
  }

  return res.json();
}

export async function completeUploadSessionApi(
  uploadId: string,
  signal?: AbortSignal
): Promise<{
  ok: boolean;
  projectId: string;
  storagePath: string;
  videoUrl: string;
  sizeBytes: number;
  mimeType: string;
  formatName: string;
}> {
  const headers = await buildAuthHeaders();
  const res = await fetch(`/api/upload-session/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    headers,
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to complete upload session' }));
    throw new Error(err.error || `Upload completion failed with status ${res.status}`);
  }
  return res.json();
}

export async function cancelUploadSessionApi(uploadId: string): Promise<boolean> {
  try {
    const headers = await buildAuthHeaders();
    const res = await fetch(`/api/upload-session/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
      headers,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getUploadSessionStatusApi(uploadId: string): Promise<{
  uploadId: string;
  projectId: string;
  status: string;
  receivedChunks: number[];
  receivedCount: number;
  totalChunks: number;
  uploadedBytes: number;
  expectedSizeBytes: number;
}> {
  const headers = await buildAuthHeaders();
  const res = await fetch(`/api/upload-session/${encodeURIComponent(uploadId)}`, {
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to get upload session status' }));
    throw new Error(err.error || `Failed to get session status (${res.status})`);
  }
  return res.json();
}

/**
 * Uploads large video/audio files with validated sessions, chunk sequence verification,
 * duplicate handling, exponential-backoff retries, and cancellation support.
 */
export async function uploadAndStartTranscription(params: {
  file?: File;
  uid?: string;
  projectId?: string;
  title: string;
  language: LanguageOption;
  provider: AsrProvider;
  wordsPerSegment?: WordsPerSegmentOption;
  useDemoClip?: boolean;
  youtubeUrl?: string;
  signal?: AbortSignal;
  onSessionCreated?: (uploadId: string) => void;
  onUploadProgress?: (
    percent: number,
    uploadedBytes: number,
    totalBytes: number,
    currentChunk: number,
    totalChunks: number
  ) => void;
}): Promise<CreateProjectResponse> {
  const effectiveProjectId = params.projectId || `proj_${Date.now().toString(36)}`;
  let uploadedFileName = '';
  const authHeaders = await buildAuthHeaders();

  if (!params.useDemoClip && params.file) {
    const file = params.file;
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunks
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    // 1. Create a secure upload session on the server
    const session = await createUploadSessionApi({
      projectId: effectiveProjectId,
      fileName: file.name,
      expectedSizeBytes: file.size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
    });

    if (params.onSessionCreated) {
      params.onSessionCreated(session.uploadId);
    }

    // 2. Upload chunks sequentially with exponential-backoff retry (Tasks 9 & 10)
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      if (params.signal?.aborted) {
        await cancelUploadSessionApi(session.uploadId);
        throw new Error('Upload cancelled by user');
      }

      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const blobSlice = file.slice(start, end);

      let chunkUploaded = false;
      let lastChunkError: Error | null = null;
      const MAX_RETRIES = 3;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (params.signal?.aborted) {
            await cancelUploadSessionApi(session.uploadId);
            throw new Error('Upload cancelled by user');
          }

          await uploadSessionChunkApi({
            uploadId: session.uploadId,
            chunkIndex,
            chunkBlob: blobSlice,
            fileName: file.name,
            signal: params.signal,
          });

          chunkUploaded = true;
          break;
        } catch (err: any) {
          if (params.signal?.aborted || err.name === 'AbortError') {
            await cancelUploadSessionApi(session.uploadId);
            throw new Error('Upload cancelled by user');
          }
          lastChunkError = err;
          if (attempt < MAX_RETRIES) {
            // Exponential backoff: 500ms, 1000ms, 2000ms
            const delay = 500 * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      if (!chunkUploaded) {
        await cancelUploadSessionApi(session.uploadId);
        throw new Error(
          `Chunk ${chunkIndex + 1}/${totalChunks} failed after ${MAX_RETRIES} retries: ${lastChunkError?.message}`
        );
      }

      if (params.onUploadProgress) {
        const pct = Math.min(100, Math.round((end / Math.max(1, file.size)) * 100));
        params.onUploadProgress(pct, end, file.size, chunkIndex + 1, totalChunks);
      }
    }

    // 3. Finalize and verify assembled media file on the server (Task 11)
    if (params.signal?.aborted) {
      await cancelUploadSessionApi(session.uploadId);
      throw new Error('Upload cancelled by user');
    }

    await completeUploadSessionApi(session.uploadId, params.signal);
    uploadedFileName = 'video.mp4';
  }

  // 4. Initiate transcription job
  const formData = new FormData();
  formData.append('projectId', effectiveProjectId);
  formData.append('title', params.title);
  formData.append('language', params.language);
  formData.append('provider', params.provider);
  formData.append('wordsPerSegment', String(params.wordsPerSegment ?? 0));

  if (params.youtubeUrl) {
    formData.append('youtubeUrl', params.youtubeUrl);
  }
  if (params.useDemoClip) {
    formData.append('useDemoClip', 'true');
  } else if (uploadedFileName) {
    formData.append('uploadedFileName', uploadedFileName);
    formData.append('mimeType', params.file?.type || 'video/mp4');
  }

  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: authHeaders,
    body: formData,
    signal: params.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to create project' }));
    throw new Error(err.error || `Failed to create project (${res.status})`);
  }
  return res.json();
}

export async function uploadCustomKhmerFont(file: File): Promise<{
  ok: boolean;
  fontFamilyName: string;
  fileName: string;
  fontUrl: string;
}> {
  const authHeaders = await buildAuthHeaders();
  const formData = new FormData();
  formData.append('font', file);
  const res = await fetch('/api/fonts/upload', {
    method: 'POST',
    headers: authHeaders,
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Font upload failed' }));
    throw new Error(err.error || `Font upload failed (${res.status})`);
  }
  return res.json();
}

export async function fetchBackendProject(projectId: string): Promise<{
  projectId: string;
  videoUrl: string;
  audioUrl: string;
  status: string;
  segments: SubtitleSegment[];
  wordsPerSegment?: WordsPerSegmentOption;
}> {
  const headers = await buildAuthHeaders();
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch project from server' }));
    throw new Error(err.error || `Failed to fetch project from server (${res.status})`);
  }
  return res.json();
}

export async function deleteBackendProject(projectId: string): Promise<{ ok: boolean; projectId: string }> {
  const headers = await buildAuthHeaders();
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to delete project on server' }));
    throw new Error(err.error || `Failed to delete project on server (${res.status})`);
  }
  return res.json();
}

export async function fetchJobStatus(jobId: string): Promise<JobRecord> {
  const headers = await buildAuthHeaders();
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch job status' }));
    throw new Error(err.error || `Failed to fetch job status (${res.status})`);
  }
  return res.json();
}

export async function syncSegmentsToBackend(
  projectId: string,
  segments: SubtitleSegment[]
): Promise<{ ok: boolean; count: number }> {
  const headers = await buildAuthHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/segments`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to sync segments to backend' }));
    throw new Error(err.error || `Failed to sync segments to backend (${res.status})`);
  }
  return res.json();
}

export async function startProjectExport(params: {
  projectId: string;
  uid?: string;
  format: ExportFormat;
  segments: SubtitleSegment[];
  template?: CaptionTemplate;
  wordsPerSegment?: WordsPerSegmentOption;
  videoUrl?: string;
}): Promise<{
  jobId: string;
  exportId: string;
  format: ExportFormat;
  outputPath: string;
  downloadUrl: string;
  fontUsed: string;
  sizeBytes?: number;
}> {
  const headers = await buildAuthHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(`/api/projects/${encodeURIComponent(params.projectId)}/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(err.error || `Export failed (${res.status})`);
  }
  return res.json();
}

/**
 * Downloads an exported file using 4MB binary chunks (/api/projects/:id/download-chunk)
 * with Authorization: Bearer <token> so Cloud Run's 32MB HTTP response limit
 * NEVER triggers a 500 error and users are properly authenticated and authorized.
 */
export async function downloadExportedFileChunked(params: {
  projectId: string;
  uid?: string;
  format: ExportFormat;
  knownSizeBytes?: number;
  expectedMime?: string;
  onProgress?: (percent: number, downloadedBytes: number, totalBytes: number) => void;
}): Promise<Blob> {
  const safePid = encodeURIComponent(params.projectId);
  const safeFmt = encodeURIComponent(params.format);
  const authHeaders = await buildAuthHeaders();

  let totalBytes = params.knownSizeBytes || 0;
  let mime = params.expectedMime || (params.format === 'burn' ? 'video/mp4' : 'text/plain;charset=utf-8');

  if (!totalBytes || totalBytes <= 0) {
    const infoRes = await fetch(
      `/api/projects/${safePid}/download-info?format=${safeFmt}`,
      {
        method: 'GET',
        headers: authHeaders,
        credentials: 'include',
      }
    );
    if (!infoRes.ok) {
      const err = await infoRes.json().catch(() => ({ error: `Download info failed (${infoRes.status})` }));
      throw new Error(err.error || `Download info failed (${infoRes.status})`);
    }
    const info = await infoRes.json();
    totalBytes = Number(info.sizeBytes) || 0;
    if (info.mime) mime = info.mime;
  }

  if (totalBytes <= 0) {
    throw new Error('Exported file is empty');
  }

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk
  const parts: BlobPart[] = [];
  let offset = 0;

  while (offset < totalBytes) {
    const length = Math.min(CHUNK_SIZE, totalBytes - offset);
    const chunkUrl = `/api/projects/${safePid}/download-chunk?format=${safeFmt}&offset=${offset}&length=${length}&t=${Date.now()}`;
    const chunkRes = await fetch(chunkUrl, {
      method: 'GET',
      headers: authHeaders,
      credentials: 'include',
    });

    if (!chunkRes.ok) {
      throw new Error(`Chunk download failed (${chunkRes.status}) at byte ${offset}`);
    }

    const buf = await chunkRes.arrayBuffer();
    if (buf.byteLength === 0) {
      break;
    }

    parts.push(new Uint8Array(buf));
    offset += buf.byteLength;

    if (params.onProgress) {
      const pct = Math.min(100, Math.round((offset / Math.max(1, totalBytes)) * 100));
      params.onProgress(pct, offset, totalBytes);
    }
  }

  return new Blob(parts, { type: mime });
}

export async function requestAiAnalysis(params: {
  title: string;
  segments: SubtitleSegment[];
}): Promise<AiAnalysisResult> {
  const headers = await buildAuthHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to generate AI analysis' }));
    throw new Error(err.error || `Failed to generate AI analysis (${res.status})`);
  }
  return res.json();
}

export async function askTranscriptAiChat(params: {
  question: string;
  segments: SubtitleSegment[];
}): Promise<{ answer: string }> {
  const headers = await buildAuthHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to ask AI' }));
    throw new Error(err.error || `Failed to ask AI (${res.status})`);
  }
  return res.json();
}

export async function translateTranscriptSegments(params: {
  segments: SubtitleSegment[];
  targetLang: 'km' | 'en';
}): Promise<{ segments: SubtitleSegment[] }> {
  const headers = await buildAuthHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch('/api/ai/translate', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to translate segments' }));
    throw new Error(err.error || `Failed to translate segments (${res.status})`);
  }
  return res.json();
}
