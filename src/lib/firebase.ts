import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  ProjectRecord,
  SubtitleSegment,
  JobRecord,
  ExportRecord,
  CaptionTemplate,
  UserProfileRecord,
  VALIDATION_LIMITS,
  clampString,
  sanitizeId,
} from '../../shared/segment.schema';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Validates connection to Firestore on boot as required by firebase-integration-rpc
 */
export async function testFirestoreConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

testFirestoreConnection();

export async function signInWithGoogle(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(cred.user);
  return cred.user;
}

export async function signOutUser(): Promise<void> {
  await fbSignOut(auth);
}

/**
 * Ensures the authenticated user's document exists in /users/{uid}
 */
export async function ensureUserProfile(user: User): Promise<UserProfileRecord> {
  const userPath = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data() as UserProfileRecord;
    }
    const newProfile = {
      uid: sanitizeId(user.uid),
      displayName: clampString(user.displayName || user.email?.split('@')[0] || 'Creator', VALIDATION_LIMITS.DISPLAY_NAME_MAX_LEN),
      email: clampString(user.email || 'user@example.com', VALIDATION_LIMITS.EMAIL_MAX_LEN),
      plan: 'free' as const,
      minutesTranscribed: 0,
      minutesLimit: 60,
      periodStart: new Date().toISOString().slice(0, 64),
      defaultLanguage: 'km+en' as const,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(ref, newProfile);
    return newProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

/**
 * Creates a new Project in Firestore (/projects/{projectId})
 */
export async function createFirestoreProject(project: ProjectRecord): Promise<void> {
  const projectId = sanitizeId(project.id);
  const path = `projects/${projectId}`;
  try {
    await setDoc(doc(db, 'projects', projectId), {
      ownerId: sanitizeId(project.ownerId),
      title: clampString(project.title || 'Untitled Video', VALIDATION_LIMITS.PROJECT_TITLE_MAX_LEN),
      videoStoragePath: clampString(project.videoStoragePath, VALIDATION_LIMITS.PATH_MAX_LEN),
      videoUrl: clampString(project.videoUrl, VALIDATION_LIMITS.URL_MAX_LEN),
      durationSec: Math.max(0, Math.min(86400, Number(project.durationSec) || 0)),
      sizeBytes: Math.max(0, Number(project.sizeBytes) || 0),
      mimeType: clampString(project.mimeType || 'video/mp4', 100),
      audioPath: clampString(project.audioPath || '', VALIDATION_LIMITS.PATH_MAX_LEN),
      language: project.language || 'km+en',
      status: project.status || 'transcribing',
      segmentCount: Math.max(0, Number(project.segmentCount) || 0),
      editedCount: Math.max(0, Number(project.editedCount) || 0),
      lastJobId: clampString(project.lastJobId || '', VALIDATION_LIMITS.ID_MAX_LEN),
      tags: (project.tags || []).slice(0, VALIDATION_LIMITS.MAX_TAGS).map((t) => clampString(t, VALIDATION_LIMITS.TAG_MAX_LEN)),
      deletedAt: clampString(project.deletedAt || '', 64),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

/**
 * Updates allowed fields on /projects/{projectId}
 */
export async function updateFirestoreProject(
  projectId: string,
  updates: Partial<Omit<ProjectRecord, 'id' | 'ownerId' | 'createdAt'>>
): Promise<void> {
  const cleanId = sanitizeId(projectId);
  const path = `projects/${cleanId}`;
  try {
    const payload: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (updates.title !== undefined) payload.title = clampString(updates.title, VALIDATION_LIMITS.PROJECT_TITLE_MAX_LEN);
    if (updates.videoStoragePath !== undefined) payload.videoStoragePath = clampString(updates.videoStoragePath, VALIDATION_LIMITS.PATH_MAX_LEN);
    if (updates.videoUrl !== undefined) payload.videoUrl = clampString(updates.videoUrl, VALIDATION_LIMITS.URL_MAX_LEN);
    if (updates.durationSec !== undefined) payload.durationSec = Math.max(0, Math.min(86400, Number(updates.durationSec) || 0));
    if (updates.sizeBytes !== undefined) payload.sizeBytes = Math.max(0, Number(updates.sizeBytes) || 0);
    if (updates.mimeType !== undefined) payload.mimeType = clampString(updates.mimeType, 100);
    if (updates.audioPath !== undefined) payload.audioPath = clampString(updates.audioPath, VALIDATION_LIMITS.PATH_MAX_LEN);
    if (updates.language !== undefined) payload.language = updates.language;
    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.segmentCount !== undefined) payload.segmentCount = Math.max(0, Number(updates.segmentCount) || 0);
    if (updates.editedCount !== undefined) payload.editedCount = Math.max(0, Number(updates.editedCount) || 0);
    if (updates.lastJobId !== undefined) payload.lastJobId = clampString(updates.lastJobId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (updates.tags !== undefined) payload.tags = updates.tags.slice(0, 10).map((t) => clampString(t, 50));
    if (updates.deletedAt !== undefined) payload.deletedAt = clampString(updates.deletedAt, 64);

    await updateDoc(doc(db, 'projects', cleanId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

/**
 * Soft deletes a project by setting deletedAt timestamp
 */
export async function softDeleteFirestoreProject(projectId: string): Promise<void> {
  await updateFirestoreProject(projectId, {
    deletedAt: new Date().toISOString().slice(0, 64),
  });
}

/**
 * Batch saves subtitle segments (up to 500 operations per batch)
 * and updates denormalized segmentCount and editedCount on the parent project.
 */
export async function batchSaveSegmentsToFirestore(
  projectId: string,
  ownerId: string,
  segments: SubtitleSegment[],
  deletedSegmentIds: string[] = []
): Promise<void> {
  const cleanProjectId = sanitizeId(projectId);
  const cleanOwnerId = sanitizeId(ownerId);
  const path = `projects/${cleanProjectId}/segments`;

  try {
    const batch = writeBatch(db);

    for (const delId of deletedSegmentIds) {
      const segRef = doc(db, 'projects', cleanProjectId, 'segments', sanitizeId(delId));
      batch.delete(segRef);
    }

    let editedCount = 0;
    segments.slice(0, 480).forEach((seg, idx) => {
      if (seg.edited) editedCount++;
      const segId = sanitizeId(seg.id || `seg_${String(idx + 1).padStart(3, '0')}`);
      const segRef = doc(db, 'projects', cleanProjectId, 'segments', segId);
      const startVal = Math.max(0, Number(seg.start) || 0);
      const endVal = Math.max(startVal, Number(seg.end) || startVal + 1);

      batch.set(segRef, {
        ownerId: cleanOwnerId,
        projectId: cleanProjectId,
        index: idx,
        start: startVal,
        end: endVal,
        text: clampString(seg.text, VALIDATION_LIMITS.SEGMENT_TEXT_MAX_LEN),
        originalText: clampString(seg.originalText || seg.text, VALIDATION_LIMITS.SEGMENT_TEXT_MAX_LEN),
        speaker: clampString(seg.speaker || 'Speaker 1', VALIDATION_LIMITS.SPEAKER_MAX_LEN),
        lang: seg.lang || 'km',
        confidence: Math.max(0, Math.min(1, Number(seg.confidence ?? 0.92))),
        edited: Boolean(seg.edited),
        editedBy: clampString(seg.editedBy || '', VALIDATION_LIMITS.ID_MAX_LEN),
        updatedAt: serverTimestamp(),
      });
    });

    const projRef = doc(db, 'projects', cleanProjectId);
    batch.update(projRef, {
      segmentCount: segments.length,
      editedCount,
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Records or updates a background job in /projects/{projectId}/jobs/{jobId}
 */
export async function createFirestoreJob(job: JobRecord): Promise<void> {
  const cleanProjectId = sanitizeId(job.projectId);
  const cleanJobId = sanitizeId(job.id);
  const path = `projects/${cleanProjectId}/jobs/${cleanJobId}`;
  try {
    await setDoc(doc(db, 'projects', cleanProjectId, 'jobs', cleanJobId), {
      ownerId: sanitizeId(job.ownerId),
      projectId: cleanProjectId,
      type: job.type,
      status: job.status,
      progress: Math.max(0, Math.min(1, Number(job.progress) || 0)),
      step: job.step,
      provider: job.provider,
      error: clampString(job.error || '', VALIDATION_LIMITS.ERROR_MAX_LEN),
      attempts: Math.max(1, Math.min(10, Number(job.attempts) || 1)),
      startedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreJob(
  projectId: string,
  jobId: string,
  updates: Pick<JobRecord, 'status' | 'progress' | 'step' | 'error' | 'attempts'>
): Promise<void> {
  const cleanProjectId = sanitizeId(projectId);
  const cleanJobId = sanitizeId(jobId);
  const path = `projects/${cleanProjectId}/jobs/${cleanJobId}`;
  try {
    await updateDoc(doc(db, 'projects', cleanProjectId, 'jobs', cleanJobId), {
      status: updates.status,
      progress: Math.max(0, Math.min(1, Number(updates.progress) || 0)),
      step: updates.step,
      error: clampString(updates.error || '', VALIDATION_LIMITS.ERROR_MAX_LEN),
      attempts: Math.max(1, Math.min(10, Number(updates.attempts) || 1)),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

/**
 * Records an export artifact in /projects/{projectId}/exports/{exportId}
 */
export async function createFirestoreExport(exp: ExportRecord): Promise<void> {
  const cleanProjectId = sanitizeId(exp.projectId);
  const cleanExportId = sanitizeId(exp.id);
  const path = `projects/${cleanProjectId}/exports/${cleanExportId}`;
  try {
    await setDoc(doc(db, 'projects', cleanProjectId, 'exports', cleanExportId), {
      ownerId: sanitizeId(exp.ownerId),
      projectId: cleanProjectId,
      format: exp.format,
      outputPath: clampString(exp.outputPath, VALIDATION_LIMITS.PATH_MAX_LEN),
      url: clampString(exp.url, VALIDATION_LIMITS.URL_MAX_LEN),
      fontUsed: clampString(exp.fontUsed || 'Battambang', 100),
      createdBy: sanitizeId(exp.createdBy),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

/**
 * Creates a custom caption style template in /templates/{templateId}
 */
export async function saveFirestoreTemplate(template: CaptionTemplate): Promise<void> {
  const cleanId = sanitizeId(template.id);
  const path = `templates/${cleanId}`;
  try {
    await setDoc(doc(db, 'templates', cleanId), {
      ownerId: sanitizeId(template.ownerId),
      name: clampString(template.name, VALIDATION_LIMITS.TEMPLATE_NAME_MAX_LEN),
      font: template.font,
      fontSize: Math.max(16, Math.min(96, Number(template.fontSize) || 42)),
      primaryColor: VALIDATION_LIMITS.HEX_COLOR_PATTERN.test(template.primaryColor)
        ? template.primaryColor
        : '#FFFFFF',
      accentColor: VALIDATION_LIMITS.HEX_COLOR_PATTERN.test(template.accentColor)
        ? template.accentColor
        : '#FFD60A',
      outline: Math.max(0, Math.min(10, Number(template.outline) ?? 3)),
      position: template.position,
      isPublic: Boolean(template.isPublic),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteFirestoreTemplate(templateId: string): Promise<void> {
  const cleanId = sanitizeId(templateId);
  const path = `templates/${cleanId}`;
  try {
    await deleteDoc(doc(db, 'templates', cleanId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

/**
 * Real-time subscription helpers with mandatory error callbacks
 */
export function subscribeUserProjects(
  uid: string,
  onData: (projects: ProjectRecord[]) => void
) {
  const path = 'projects';
  const q = query(collection(db, 'projects'), where('ownerId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list: ProjectRecord[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as Omit<ProjectRecord, 'id'>;
        if (!data.deletedAt) {
          list.push({ id: docSnap.id, ...data });
        }
      });
      onData(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeProjectSegments(
  projectId: string,
  uid: string,
  onData: (segments: SubtitleSegment[]) => void
) {
  const cleanProjectId = sanitizeId(projectId);
  const path = `projects/${cleanProjectId}/segments`;
  const q = query(
    collection(db, 'projects', cleanProjectId, 'segments'),
    where('ownerId', '==', uid)
  );
  return onSnapshot(
    q,
    (snap) => {
      const list: SubtitleSegment[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as Omit<SubtitleSegment, 'id'>;
        list.push({ id: docSnap.id, ...data });
      });
      list.sort((a, b) => a.index - b.index || a.start - b.start);
      onData(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeProjectExports(
  projectId: string,
  uid: string,
  onData: (exportsList: ExportRecord[]) => void
) {
  const cleanProjectId = sanitizeId(projectId);
  const path = `projects/${cleanProjectId}/exports`;
  const q = query(
    collection(db, 'projects', cleanProjectId, 'exports'),
    where('ownerId', '==', uid)
  );
  return onSnapshot(
    q,
    (snap) => {
      const list: ExportRecord[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as Omit<ExportRecord, 'id'>;
        list.push({ id: docSnap.id, ...data });
      });
      onData(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeUserTemplates(
  uid: string,
  onData: (templates: CaptionTemplate[]) => void
) {
  const path = 'templates';
  const q = query(collection(db, 'templates'), where('ownerId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list: CaptionTemplate[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as Omit<CaptionTemplate, 'id'>;
        list.push({ id: docSnap.id, ...data });
      });
      onData(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}
