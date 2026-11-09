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

export async function requestUploadUrl(params: {
  uid: string;
  fileName: string;
  mimeType: string;
}): Promise<UploadUrlResponse> {
  const res = await fetch('/api/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to get upload URL' }));
    throw new Error(err.error || 'Failed to get upload URL');
  }
  return res.json();
}

/**
 * Uploads any size video/audio file using 4 MB resumable chunks so large videos (100MB - 2GB+)
 * never hit HTTP proxy request size limits, then starts the transcription job.
 */
export async function uploadAndStartTranscription(params: {
  file?: File;
  uid: string;
  projectId?: string;
  title: string;
  language: LanguageOption;
  provider: AsrProvider;
  wordsPerSegment?: WordsPerSegmentOption;
  useDemoClip?: boolean;
  youtubeUrl?: string;
  onUploadProgress?: (percent: number, uploadedBytes: number, totalBytes: number) => void;
}): Promise<CreateProjectResponse> {
  const effectiveProjectId = params.projectId || `proj_${Date.now().toString(36)}`;
  let uploadedFileName = '';

  // Slice video into 4 MB chunks so even 500MB - 2GB videos upload reliably without proxy 413 errors
  if (!params.useDemoClip && params.file) {
    const file = params.file;
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const blobSlice = file.slice(start, end);

      const chunkForm = new FormData();
      chunkForm.append('uid', params.uid);
      chunkForm.append('projectId', effectiveProjectId);
      chunkForm.append('chunkIndex', String(chunkIndex));
      chunkForm.append('totalChunks', String(totalChunks));
      chunkForm.append('fileName', file.name);
      chunkForm.append('chunk', blobSlice, file.name);

      const chunkRes = await fetch('/api/upload-chunk', {
        method: 'POST',
        body: chunkForm,
      });

      if (!chunkRes.ok) {
        const err = await chunkRes.json().catch(() => ({ error: 'Failed to upload video chunk' }));
        throw new Error(err.error || `Failed uploading chunk ${chunkIndex + 1}/${totalChunks}`);
      }

      const chunkData = await chunkRes.json();
      uploadedFileName = chunkData.uploadedFileName || 'video.mp4';

      if (params.onUploadProgress) {
        const pct = Math.min(100, Math.round((end / Math.max(1, file.size)) * 100));
        params.onUploadProgress(pct, end, file.size);
      }
    }
  }

  const formData = new FormData();
  formData.append('uid', params.uid);
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
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to create project' }));
    throw new Error(err.error || 'Failed to create project');
  }
  return res.json();
}

export async function uploadCustomKhmerFont(file: File): Promise<{
  ok: boolean;
  fontFamilyName: string;
  fileName: string;
  fontUrl: string;
}> {
  const formData = new FormData();
  formData.append('font', file);
  const res = await fetch('/api/fonts/upload', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Font upload failed' }));
    throw new Error(err.error || 'Font upload failed');
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
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!res.ok) {
    throw new Error('Failed to fetch project from server');
  }
  return res.json();
}

export async function fetchJobStatus(jobId: string): Promise<JobRecord> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    throw new Error('Failed to fetch job status');
  }
  return res.json();
}

export async function syncSegmentsToBackend(
  projectId: string,
  segments: SubtitleSegment[]
): Promise<{ ok: boolean; count: number }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/segments`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) {
    throw new Error('Failed to sync segments to backend');
  }
  return res.json();
}

export async function startProjectExport(params: {
  projectId: string;
  uid: string;
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
  const res = await fetch(`/api/projects/${encodeURIComponent(params.projectId)}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(err.error || 'Export failed');
  }
  return res.json();
}

/**
 * Downloads an exported file (such as a burned MP4 video of any size, from 1MB to 500MB+)
 * using 4MB binary chunks (/api/projects/:id/download-chunk) so Cloud Run's 32MB HTTP response limit
 * NEVER triggers a 500 error and iframe navigation NEVER triggers a "cookie" file download.
 */
export async function downloadExportedFileChunked(params: {
  projectId: string;
  uid: string;
  format: ExportFormat;
  knownSizeBytes?: number;
  expectedMime?: string;
  onProgress?: (percent: number, downloadedBytes: number, totalBytes: number) => void;
}): Promise<Blob> {
  const safePid = encodeURIComponent(params.projectId);
  const safeUid = encodeURIComponent(params.uid || 'local_user');
  const safeFmt = encodeURIComponent(params.format);

  let totalBytes = params.knownSizeBytes || 0;
  let mime = params.expectedMime || (params.format === 'burn' ? 'video/mp4' : 'text/plain;charset=utf-8');

  if (!totalBytes || totalBytes <= 0) {
    const infoRes = await fetch(
      `/api/projects/${safePid}/download-info?format=${safeFmt}&uid=${safeUid}`,
      {
        method: 'GET',
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

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk — well below Cloud Run 32 MB response cap
  const parts: BlobPart[] = [];
  let offset = 0;

  while (offset < totalBytes) {
    const length = Math.min(CHUNK_SIZE, totalBytes - offset);
    const chunkUrl = `/api/projects/${safePid}/download-chunk?format=${safeFmt}&uid=${safeUid}&offset=${offset}&length=${length}&t=${Date.now()}`;
    const chunkRes = await fetch(chunkUrl, {
      method: 'GET',
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
  const res = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error('Failed to generate AI analysis');
  }
  return res.json();
}

export async function askTranscriptAiChat(params: {
  question: string;
  segments: SubtitleSegment[];
}): Promise<{ answer: string }> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error('Failed to ask AI');
  }
  return res.json();
}

export async function translateTranscriptSegments(params: {
  segments: SubtitleSegment[];
  targetLang: 'km' | 'en';
}): Promise<{ segments: SubtitleSegment[] }> {
  const res = await fetch('/api/ai/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error('Failed to translate segments');
  }
  return res.json();
}
