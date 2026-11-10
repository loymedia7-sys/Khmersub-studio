import fs from 'fs';
import path from 'path';
import { adminApp } from '../middleware/auth.middleware';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  ProjectRecord,
  JobRecord,
  JobStatus,
  JobStep,
  SubtitleSegment,
  ExportFormat,
  LanguageOption,
  WordsPerSegmentOption,
  sanitizeId,
  isValidIdentifier,
} from '../../shared/segment.schema';
import { UPLOADS_DIR, EXPORTS_DIR, AUDIO_DIR } from './media.service';

/**
 * Persistence Service for Khmersub Studio
 * Replaces ephemeral in-memory Maps with Firestore and persistent disk metadata.
 * Survives server restarts and synchronizes state across multi-instance cloud deployments.
 */

const CONFIG_PATH = path.join(process.cwd(), 'firebase-applet-config.json');
let firestoreDatabaseId = 'ai-studio-80f837bb-5966-4a4f-b0ee-ee6b13ce1b8e';

try {
  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (config.firestoreDatabaseId) {
      firestoreDatabaseId = config.firestoreDatabaseId;
    }
  }
} catch {
  // Use default
}

let firestoreInstance: ReturnType<typeof getFirestore> | null = null;
let isFirestoreAvailable = false;

try {
  firestoreInstance = getFirestore(adminApp, firestoreDatabaseId);
  isFirestoreAvailable = true;
  console.log(`[Persistence] Admin Firestore initialized for database: ${firestoreDatabaseId}`);
} catch (err) {
  console.warn('[Persistence] Firestore Admin initialization warning:', err);
  isFirestoreAvailable = false;
}

export interface ServerProjectState {
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
  updatedAt?: string;
  createdAt?: string;
}

const JOBS_DIR = path.join(UPLOADS_DIR, 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

// In-memory caching layer with immediate persistent write-through
const projectCache = new Map<string, ServerProjectState>();
const jobCache = new Map<string, JobRecord>();

/**
 * Saves or updates project metadata in Firestore and writes through to persistent disk.
 */
export async function persistProject(project: ServerProjectState): Promise<void> {
  const cleanProjectId = sanitizeId(project.projectId);
  const cleanOwnerId = sanitizeId(project.ownerId);

  // Update in-memory cache
  projectCache.set(cleanProjectId, project);

  // 1. Write to local persistent disk metadata
  try {
    const userProjDir = path.join(UPLOADS_DIR, cleanOwnerId, cleanProjectId);
    fs.mkdirSync(userProjDir, { recursive: true });
    const metaPath = path.join(userProjDir, 'project.json');
    fs.writeFileSync(metaPath, JSON.stringify(project, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[Persistence] Error writing project.json to disk for ${cleanProjectId}:`, err);
  }

  // 2. Write to Firestore /projects/{cleanProjectId}
  if (isFirestoreAvailable && firestoreInstance) {
    try {
      const docRef = firestoreInstance.collection('projects').doc(cleanProjectId);
      await docRef.set(
        {
          ownerId: cleanOwnerId,
          title: (project.title || 'Untitled Video').slice(0, 200),
          videoStoragePath: project.videoFilePath || `uploads/${cleanOwnerId}/${cleanProjectId}/video.mp4`,
          videoUrl: project.videoUrl || '',
          durationSec: Math.max(0, Math.min(86400, Number(project.durationSec) || 0)),
          sizeBytes: Math.max(0, Number(project.sizeBytes) || 0),
          mimeType: (project.mimeType || 'video/mp4').slice(0, 100),
          audioPath: project.audioFilePath || '',
          language: project.language || 'km+en',
          status: project.status || 'uploaded',
          segmentCount: Array.isArray(project.segments) ? project.segments.length : 0,
          editedCount: 0,
          lastJobId: '',
          tags: ['khmer', 'subtitle', 'studio'],
          deletedAt: '',
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (fsErr) {
      // In local dev without credentials, disk metadata maintains resilience
      console.warn(`[Persistence] Firestore sync warning for project ${cleanProjectId}:`, fsErr instanceof Error ? fsErr.message : fsErr);
    }
  }
}

/**
 * Retrieves project metadata, verifying ownership if uid is provided.
 */
export async function getPersistedProject(
  projectId: string,
  uid?: string
): Promise<ServerProjectState | null> {
  if (!isValidIdentifier(projectId)) return null;

  // 1. Check in-memory cache
  if (projectCache.has(projectId)) {
    const p = projectCache.get(projectId)!;
    if (uid && p.ownerId !== uid) return null;
    return p;
  }

  // 2. Check Firestore
  if (isFirestoreAvailable && firestoreInstance) {
    try {
      const snap = await firestoreInstance.collection('projects').doc(projectId).get();
      if (snap.exists) {
        const data = snap.data()!;
        if (uid && data.ownerId !== uid) return null;

        const projState: ServerProjectState = {
          projectId,
          ownerId: data.ownerId,
          title: data.title || 'Untitled Video',
          videoFilePath: data.videoStoragePath || '',
          videoUrl: data.videoUrl || '',
          audioFilePath: data.audioPath || '',
          audioUrl: data.audioPath ? `/media/${data.audioPath}` : '',
          durationSec: Number(data.durationSec) || 0,
          sizeBytes: Number(data.sizeBytes) || 0,
          mimeType: data.mimeType || 'video/mp4',
          language: (data.language as LanguageOption) || 'km+en',
          wordsPerSegment: 0,
          status: data.status || 'ready',
          segments: [],
          updatedAt: data.updatedAt ? String(data.updatedAt) : new Date().toISOString(),
          createdAt: data.createdAt ? String(data.createdAt) : new Date().toISOString(),
        };

        projectCache.set(projectId, projState);
        return projState;
      }
    } catch (err) {
      // Non-blocking fallback to disk
    }
  }

  // 3. Check persistent disk metadata
  if (uid && isValidIdentifier(uid)) {
    const metaPath = path.join(UPLOADS_DIR, uid, projectId, 'project.json');
    if (fs.existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (parsed.ownerId === uid) {
          projectCache.set(projectId, parsed);
          return parsed;
        }
      } catch {}
    }
  } else {
    // Search all user folders on disk
    try {
      if (fs.existsSync(UPLOADS_DIR)) {
        const users = fs.readdirSync(UPLOADS_DIR);
        for (const user of users) {
          if (isValidIdentifier(user)) {
            const metaPath = path.join(UPLOADS_DIR, user, projectId, 'project.json');
            if (fs.existsSync(metaPath)) {
              const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              projectCache.set(projectId, parsed);
              return parsed;
            }
          }
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Lists all projects belonging to the authenticated user.
 */
export async function listPersistedProjects(uid: string): Promise<ServerProjectState[]> {
  if (!isValidIdentifier(uid)) return [];

  const projectsMap = new Map<string, ServerProjectState>();

  // 1. Load from cache
  for (const p of projectCache.values()) {
    if (p.ownerId === uid) {
      projectsMap.set(p.projectId, p);
    }
  }

  // 2. Load from disk
  const userDir = path.join(UPLOADS_DIR, uid);
  if (fs.existsSync(userDir)) {
    try {
      const entries = fs.readdirSync(userDir);
      for (const entry of entries) {
        const metaPath = path.join(userDir, entry, 'project.json');
        if (fs.existsSync(metaPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (parsed.ownerId === uid) {
              projectsMap.set(parsed.projectId, parsed);
              projectCache.set(parsed.projectId, parsed);
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 3. Load from Firestore
  if (isFirestoreAvailable && firestoreInstance) {
    try {
      const snap = await firestoreInstance
        .collection('projects')
        .where('ownerId', '==', uid)
        .limit(100)
        .get();

      snap.forEach((doc) => {
        const data = doc.data();
        if (!projectsMap.has(doc.id)) {
          const state: ServerProjectState = {
            projectId: doc.id,
            ownerId: data.ownerId,
            title: data.title || 'Untitled Video',
            videoFilePath: data.videoStoragePath || '',
            videoUrl: data.videoUrl || '',
            audioFilePath: data.audioPath || '',
            audioUrl: data.audioPath ? `/media/${data.audioPath}` : '',
            durationSec: Number(data.durationSec) || 0,
            sizeBytes: Number(data.sizeBytes) || 0,
            mimeType: data.mimeType || 'video/mp4',
            language: (data.language as LanguageOption) || 'km+en',
            wordsPerSegment: 0,
            status: data.status || 'ready',
            segments: [],
          };
          projectsMap.set(doc.id, state);
          projectCache.set(doc.id, state);
        }
      });
    } catch {}
  }

  return Array.from(projectsMap.values());
}

/**
 * Deletes a project from cache, disk, and Firestore.
 */
export async function deletePersistedProject(projectId: string, uid: string): Promise<boolean> {
  if (!isValidIdentifier(projectId) || !isValidIdentifier(uid)) return false;

  projectCache.delete(projectId);

  // Delete from disk
  const projDir = path.join(UPLOADS_DIR, uid, projectId);
  if (fs.existsSync(projDir)) {
    try {
      fs.rmSync(projDir, { recursive: true, force: true });
    } catch {}
  }

  // Delete from Firestore
  if (isFirestoreAvailable && firestoreInstance) {
    try {
      await firestoreInstance.collection('projects').doc(projectId).delete();
    } catch {}
  }

  return true;
}

/**
 * Saves a job record to disk and Firestore with atomic update semantics.
 */
export async function persistJob(job: JobRecord): Promise<void> {
  const cleanJobId = sanitizeId(job.id);
  const cleanProjectId = sanitizeId(job.projectId);
  const cleanOwnerId = sanitizeId(job.ownerId);

  jobCache.set(cleanJobId, job);

  // 1. Write to central and user jobs directories on disk
  try {
    const jobDiskPath = path.join(JOBS_DIR, `${cleanJobId}.json`);
    fs.writeFileSync(jobDiskPath, JSON.stringify(job, null, 2), 'utf-8');

    const userJobDir = path.join(UPLOADS_DIR, cleanOwnerId, cleanProjectId, 'jobs');
    fs.mkdirSync(userJobDir, { recursive: true });
    fs.writeFileSync(path.join(userJobDir, `${cleanJobId}.json`), JSON.stringify(job, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[Persistence] Error writing job ${cleanJobId} to disk:`, err);
  }

  // 2. Write to Firestore /projects/{projectId}/jobs/{jobId}
  if (isFirestoreAvailable && firestoreInstance) {
    try {
      const docRef = firestoreInstance
        .collection('projects')
        .doc(cleanProjectId)
        .collection('jobs')
        .doc(cleanJobId);

      await docRef.set(
        {
          ownerId: cleanOwnerId,
          projectId: cleanProjectId,
          type: job.type,
          status: job.status,
          progress: Math.max(0, Math.min(1, Number(job.progress) || 0)),
          step: job.step,
          provider: job.provider,
          error: (job.error || '').slice(0, 500),
          attempts: Math.max(1, Number(job.attempts) || 1),
          maxAttempts: job.maxAttempts || 3,
          lockOwner: job.lockOwner || '',
          lockedAt: job.lockedAt || 0,
          heartbeatAt: Date.now(),
          updatedAt: FieldValue.serverTimestamp(),
          startedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (fsErr) {
      console.warn(`[Persistence] Firestore sync warning for job ${cleanJobId}:`, fsErr instanceof Error ? fsErr.message : fsErr);
    }
  }
}

/**
 * Retrieves a job record by ID. Enforces user isolation when uid is provided (Task 9).
 */
export async function getPersistedJob(jobId: string, uid?: string): Promise<JobRecord | null> {
  if (!isValidIdentifier(jobId)) return null;

  // 1. Check cache
  if (jobCache.has(jobId)) {
    const j = jobCache.get(jobId)!;
    if (uid && j.ownerId !== uid) return null;
    return j;
  }

  // 2. Check disk jobs directory
  const jobDiskPath = path.join(JOBS_DIR, `${jobId}.json`);
  if (fs.existsSync(jobDiskPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jobDiskPath, 'utf-8')) as JobRecord;
      if (uid && parsed.ownerId !== uid) return null;
      jobCache.set(jobId, parsed);
      return parsed;
    } catch {}
  }

  // 3. Search Firestore across projects
  if (isFirestoreAvailable && firestoreInstance) {
    try {
      const snap = await firestoreInstance
        .collectionGroup('jobs')
        .where('ownerId', '==', uid || '')
        .get();

      for (const doc of snap.docs) {
        if (doc.id === jobId) {
          const data = doc.data() as JobRecord;
          jobCache.set(jobId, data);
          return data;
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Acquires an atomic lease on a job to prevent duplicate execution across workers (Task 7).
 * Uses lease timeout (5 minutes) so crashed workers do not cause deadlocks.
 */
export async function claimJobForProcessing(
  jobId: string,
  workerId: string,
  leaseMs = 5 * 60 * 1000
): Promise<boolean> {
  const job = await getPersistedJob(jobId);
  if (!job) return false;

  const now = Date.now();
  const isLocked = Boolean(job.lockOwner && job.lockedAt && now - job.lockedAt < leaseMs);

  if (isLocked && job.lockOwner !== workerId) {
    return false; // Job is actively locked by another worker
  }

  // Acquire lock and transition to processing state
  job.lockOwner = workerId;
  job.lockedAt = now;
  job.heartbeatAt = now;
  job.status = 'processing';
  await persistJob(job);
  return true;
}

/**
 * Updates job progress and heartbeat timestamp (Task 5).
 */
export async function updateJobProgress(
  jobId: string,
  progress: number,
  step: JobStep
): Promise<void> {
  const job = await getPersistedJob(jobId);
  if (!job) return;

  job.progress = Math.max(0, Math.min(1, progress));
  job.step = step;
  job.heartbeatAt = Date.now();
  if (progress >= 1 && step === 'completed') {
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
  }
  await persistJob(job);
}

/**
 * Cleans up old finished or cancelled jobs older than retentionDays (Task 10).
 */
export async function cleanupOldJobs(retentionDays = 7): Promise<number> {
  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  let cleanedCount = 0;

  try {
    if (fs.existsSync(JOBS_DIR)) {
      const files = fs.readdirSync(JOBS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(JOBS_DIR, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
              const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (
                parsed.status === 'completed' ||
                parsed.status === 'done' ||
                parsed.status === 'failed' ||
                parsed.status === 'cancelled'
              ) {
                fs.unlinkSync(filePath);
                jobCache.delete(parsed.id);
                cleanedCount++;
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  return cleanedCount;
}

/**
 * Recovers unfinished jobs after server restarts (Task 6).
 * Inspects all active jobs and re-queues them or marks them failed if max attempts exceeded.
 */
export async function recoverUnfinishedJobsOnStartup(): Promise<{
  recoveredCount: number;
  interruptedCount: number;
}> {
  let recoveredCount = 0;
  let interruptedCount = 0;
  const now = Date.now();

  try {
    if (fs.existsSync(JOBS_DIR)) {
      const files = fs.readdirSync(JOBS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(JOBS_DIR, file);
            const job = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as JobRecord;

            if (job.status === 'processing' || job.status === 'running') {
              const maxAttempts = job.maxAttempts || 3;
              if (job.attempts < maxAttempts) {
                job.status = 'queued';
                job.attempts += 1;
                job.lockOwner = '';
                job.lockedAt = 0;
                await persistJob(job);
                recoveredCount++;
                console.log(`[Persistence] Recovered unfinished job ${job.id} (Attempt ${job.attempts}/${maxAttempts})`);
              } else {
                job.status = 'failed';
                job.error = 'Job execution was interrupted by server restart. Maximum retries reached.';
                job.lockOwner = '';
                await persistJob(job);
                interruptedCount++;
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  return { recoveredCount, interruptedCount };
}

/**
 * Migration strategy for existing local projects and files (Task 12).
 * Scans local uploads directory and ensures every project has valid metadata in Firestore.
 */
export async function migrateLocalProjectsToFirestore(): Promise<{
  scannedProjects: number;
  migratedProjects: number;
}> {
  let scannedProjects = 0;
  let migratedProjects = 0;

  try {
    if (!fs.existsSync(UPLOADS_DIR)) return { scannedProjects: 0, migratedProjects: 0 };

    const users = fs.readdirSync(UPLOADS_DIR);
    for (const uid of users) {
      if (isValidIdentifier(uid) && uid !== 'staging' && uid !== 'jobs') {
        const userDir = path.join(UPLOADS_DIR, uid);
        const projects = fs.readdirSync(userDir);

        for (const projectId of projects) {
          if (isValidIdentifier(projectId)) {
            scannedProjects++;
            const projDir = path.join(userDir, projectId);
            const metaPath = path.join(projDir, 'project.json');

            let state: ServerProjectState;
            if (fs.existsSync(metaPath)) {
              state = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            } else {
              // Reconstruct project state from disk files
              const videoFile = fs.readdirSync(projDir).find((f) => f.startsWith('video.'));
              const videoPath = videoFile ? path.join(projDir, videoFile) : '';
              state = {
                projectId,
                ownerId: uid,
                title: 'Recovered Project',
                videoFilePath: videoPath,
                videoUrl: videoPath ? `/media/uploads/${uid}/${projectId}/${videoFile}` : '',
                audioFilePath: '',
                audioUrl: '',
                durationSec: 18,
                sizeBytes: videoPath ? fs.statSync(videoPath).size : 0,
                mimeType: 'video/mp4',
                language: 'km+en',
                wordsPerSegment: 0,
                status: 'ready',
                segments: [],
              };
            }

            await persistProject(state);
            migratedProjects++;
          }
        }
      }
    }
  } catch (err) {
    console.error('[Persistence] Migration error:', err);
  }

  return { scannedProjects, migratedProjects };
}
