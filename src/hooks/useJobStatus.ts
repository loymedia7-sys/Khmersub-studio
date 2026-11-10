import { useEffect, useState } from 'react';
import { JobRecord } from '../../shared/segment.schema';
import { fetchJobStatus } from '../lib/api';
import { updateFirestoreJob } from '../lib/firebase';

export function useJobStatus(
  projectId: string | null,
  jobId: string | null,
  isAuthenticated: boolean,
  onCompleted?: (job: JobRecord) => void
) {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  useEffect(() => {
    if (!jobId || !projectId) {
      setJob(null);
      setIsPolling(false);
      return;
    }

    let cancelled = false;
    setIsPolling(true);

    const poll = async () => {
      try {
        const data = await fetchJobStatus(jobId);
        if (cancelled) return;
        setJob(data);

        if (isAuthenticated) {
          updateFirestoreJob(projectId, jobId, {
            status: data.status,
            progress: data.progress,
            step: data.step,
            error: data.error || '',
            attempts: data.attempts || 1,
          }).catch(() => {
            // Non-blocking if job reaches terminal state simultaneously
          });
        }

        if (
          data.status === 'done' ||
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled'
        ) {
          setIsPolling(false);
          if (onCompleted) {
            onCompleted(data);
          }
          return;
        }
      } catch {
        // Keep polling briefly if transient
      }

      if (!cancelled) {
        timer = window.setTimeout(poll, 900);
      }
    };

    let timer = window.setTimeout(poll, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId, projectId, isAuthenticated]);

  return { job, isPolling };
}
