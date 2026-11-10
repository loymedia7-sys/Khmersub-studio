import {
  JobRecord,
  JobStatus,
  JobStep,
  JobType,
  AsrProvider,
  SubtitleSegment,
} from '../../shared/segment.schema';
import {
  persistJob,
  getPersistedJob,
  claimJobForProcessing,
  updateJobProgress,
  getPersistedProject,
  persistProject,
} from './persistence.service';
import { extractAudioToWav, burnSubtitlesWithFfmpeg } from './media.service';
import { transcribeAudioWithGemini } from './asr.service';
import { writeSubtitleExportFile } from './subtitle.service';
import { uploadMediaToCloudStorage } from './cloud_storage.service';

/**
 * Job Queue & Execution Service for Khmersub Studio
 * Provides a resilient, concurrency-controlled background processing pipeline
 * that survives server restarts and prevents duplicate job execution.
 */

const MAX_CONCURRENT_JOBS = 2;
let activeWorkersCount = 0;
const waitingQueue: string[] = [];
const workerInstanceId = `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Enqueues a job for background processing.
 * Persists job state as 'queued', checks duplicates, and pumps the worker queue.
 */
export async function enqueueJob(job: JobRecord): Promise<JobRecord> {
  // Check if job is already running or completed
  const existing = await getPersistedJob(job.id);
  if (existing) {
    if (existing.status === 'processing' || existing.status === 'running') {
      console.log(`[Queue] Job ${job.id} is already actively processing. Skipping duplicate enqueue.`);
      return existing;
    }
    if (existing.status === 'completed' || existing.status === 'done') {
      console.log(`[Queue] Job ${job.id} is already completed. Skipping duplicate execution.`);
      return existing;
    }
  }

  job.status = 'queued';
  job.step = 'queued';
  job.progress = 0.05;
  job.attempts = job.attempts || 1;
  job.maxAttempts = job.maxAttempts || 3;

  await persistJob(job);
  waitingQueue.push(job.id);
  processNextInQueue();
  return job;
}

/**
 * Pumps the queue up to MAX_CONCURRENT_JOBS.
 */
async function processNextInQueue() {
  if (activeWorkersCount >= MAX_CONCURRENT_JOBS || waitingQueue.length === 0) {
    return;
  }

  const jobId = waitingQueue.shift();
  if (!jobId) return;

  activeWorkersCount++;
  try {
    await executeJob(jobId);
  } finally {
    activeWorkersCount--;
    processNextInQueue();
  }
}

/**
 * Executes a single job with atomic claim, progress persistence, and retry logic.
 */
export async function executeJob(jobId: string): Promise<void> {
  const job = await getPersistedJob(jobId);
  if (!job) return;

  // Prevent duplicate execution via atomic lease (Task 7)
  const claimed = await claimJobForProcessing(jobId, workerInstanceId);
  if (!claimed) {
    console.log(`[Queue] Worker could not acquire lease on job ${jobId}; another worker is running it.`);
    return;
  }

  console.log(`[Queue] Worker ${workerInstanceId} started processing job ${jobId} (Attempt ${job.attempts}/${job.maxAttempts})`);

  try {
    const project = await getPersistedProject(job.projectId);
    if (!project) {
      throw new Error(`Project ${job.projectId} not found for job execution`);
    }

    if (job.type === 'transcribe') {
      // Step 1: Audio Extraction (Task 4 & 5)
      await updateJobProgress(jobId, 0.20, 'extract_audio');
      let audioPath = project.audioFilePath;

      if (!audioPath) {
        audioPath = await extractAudioToWav(
          project.videoFilePath,
          project.ownerId,
          project.projectId
        );
        project.audioFilePath = audioPath;
        project.audioUrl = `/media/audio/${project.ownerId}/${project.projectId}/audio.mp3`;
        await persistProject(project);
      }

      // Step 2: ASR via Gemini (Task 4 & 5)
      await updateJobProgress(jobId, 0.45, 'asr');
      const segments = await transcribeAudioWithGemini({
        audioFilePath: audioPath,
        language: project.language,
        wordsPerSegment: project.wordsPerSegment || 0,
        provider: job.provider,
      });

      // Step 3: Postprocess & Save (Task 4 & 5)
      await updateJobProgress(jobId, 0.85, 'postprocess');
      project.segments = segments;
      project.status = 'ready';
      project.durationSec = segments.length > 0
        ? Math.max(project.durationSec, segments[segments.length - 1].end)
        : project.durationSec;
      await persistProject(project);

      // Step 4: Completed
      job.resultSegments = segments;
      job.status = 'completed';
      await updateJobProgress(jobId, 1.0, 'completed');
      console.log(`[Queue] Job ${jobId} completed successfully with ${segments.length} segments.`);
    } else if (job.type === 'export_burn') {
      // Step 1: Burn Subtitles via FFmpeg
      await updateJobProgress(jobId, 0.30, 'burn_subtitles');
      const exportItem = (job as any).exportPayload;
      if (!exportItem) {
        throw new Error('Missing export payload for burn job');
      }

      const burnedResult = await burnSubtitlesWithFfmpeg({
        videoFilePath: project.videoFilePath,
        uid: project.ownerId,
        projectId: project.projectId,
        segments: exportItem.segments || project.segments,
        font: exportItem.font || 'Battambang',
        fontSize: exportItem.fontSize || 38,
        primaryColor: exportItem.primaryColor || '#FFFFFF',
        accentColor: exportItem.accentColor || '#FFD60A',
        outline: exportItem.outline ?? 3,
        position: exportItem.position || 'bottom',
        aspectRatio: exportItem.aspectRatio || 'original',
      });

      // Optionally sync burned video to Cloud Storage (Task 3)
      await uploadMediaToCloudStorage({
        localFilePath: burnedResult.burnedFilePath,
        destinationPath: `exports/${project.ownerId}/${project.projectId}/burned_${Date.now()}.mp4`,
        mimeType: 'video/mp4',
      });

      job.exportResult = {
        format: 'burn',
        outputPath: burnedResult.burnedFilePath,
        url: burnedResult.burnedVideoUrl,
        fontUsed: exportItem.font || 'Battambang',
      };
      job.status = 'completed';
      await updateJobProgress(jobId, 1.0, 'completed');
    } else {
      // Subtitle text file export (SRT, VTT, TXT)
      const exportItem = (job as any).exportPayload;
      const written = writeSubtitleExportFile({
        uid: project.ownerId,
        projectId: project.projectId,
        format: job.type.replace('export_', '') as any,
        segments: exportItem?.segments || project.segments,
      });

      job.exportResult = {
        format: written.format as any,
        outputPath: written.fullPath,
        url: written.downloadUrl,
        fontUsed: 'Standard',
      };
      job.status = 'completed';
      await updateJobProgress(jobId, 1.0, 'completed');
    }
  } catch (err: any) {
    console.error(`[Queue] Error executing job ${jobId}:`, err);
    const maxAttempts = job.maxAttempts || 3;

    if (job.attempts < maxAttempts) {
      // Safe retry with exponential backoff (Task 8)
      job.attempts += 1;
      job.status = 'queued';
      job.lockOwner = '';
      job.lockedAt = 0;
      job.error = `Attempt ${job.attempts - 1} failed: ${err.message}. Retrying...`;
      await persistJob(job);

      const delay = 1000 * Math.pow(2, job.attempts - 1);
      setTimeout(() => {
        waitingQueue.push(jobId);
        processNextInQueue();
      }, delay);
      console.log(`[Queue] Job ${jobId} scheduled for retry ${job.attempts}/${maxAttempts} in ${delay}ms`);
    } else {
      // Terminal failure
      job.status = 'failed';
      job.error = err.message || 'Job execution failed';
      job.lockOwner = '';
      await persistJob(job);
    }
  }
}

/**
 * Allows a user to safely retry a failed or cancelled job (Task 8).
 */
export async function retryJob(jobId: string, uid: string): Promise<JobRecord> {
  const job = await getPersistedJob(jobId, uid);
  if (!job) {
    throw new Error('Job not found or unauthorized');
  }

  if (job.status === 'processing' || job.status === 'running') {
    throw new Error('Job is already actively running');
  }

  job.status = 'queued';
  job.step = 'queued';
  job.progress = 0.05;
  job.error = '';
  job.lockOwner = '';
  job.lockedAt = 0;
  job.attempts = 1;

  await persistJob(job);
  waitingQueue.push(job.id);
  processNextInQueue();
  return job;
}

/**
 * Cancels an active or queued job (Task 4).
 */
export async function cancelJob(jobId: string, uid: string): Promise<JobRecord> {
  const job = await getPersistedJob(jobId, uid);
  if (!job) {
    throw new Error('Job not found or unauthorized');
  }

  job.status = 'cancelled';
  job.error = 'Cancelled by user';
  job.lockOwner = '';
  job.lockedAt = 0;

  // Remove from waiting queue if not yet picked up
  const queueIdx = waitingQueue.indexOf(jobId);
  if (queueIdx !== -1) {
    waitingQueue.splice(queueIdx, 1);
  }

  await persistJob(job);
  return job;
}
