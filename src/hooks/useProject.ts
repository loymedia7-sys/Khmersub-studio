import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ProjectRecord,
  SubtitleSegment,
  ExportRecord,
} from '../../shared/segment.schema';
import {
  subscribeProjectSegments,
  subscribeProjectExports,
  batchSaveSegmentsToFirestore,
} from '../lib/firebase';
import { fetchBackendProject, syncSegmentsToBackend } from '../lib/api';
import { detectSegmentLanguage } from '../lib/srt';

export function useProject(
  project: ProjectRecord | null,
  uid: string | null
) {
  const [segments, setSegments] = useState<SubtitleSegment[]>([]);
  const [exportsList, setExportsList] = useState<ExportRecord[]>([]);
  const [loadingSegments, setLoadingSegments] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const deletedIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!project) {
      setSegments([]);
      setExportsList([]);
      return;
    }

    setLoadingSegments(true);
    deletedIdsRef.current = [];

    if (uid) {
      const unsubSegs = subscribeProjectSegments(project.id, uid, (liveSegments) => {
        if (liveSegments.length > 0) {
          setSegments(liveSegments);
          setLoadingSegments(false);
        } else {
          fetchBackendProject(project.id)
            .then((backendData) => {
              if (backendData.segments && backendData.segments.length > 0) {
                setSegments(backendData.segments);
              }
            })
            .catch(() => {})
            .finally(() => setLoadingSegments(false));
        }
      });

      const unsubExports = subscribeProjectExports(project.id, uid, (liveExports) => {
        setExportsList(liveExports);
      });

      return () => {
        unsubSegs();
        unsubExports();
      };
    } else {
      fetchBackendProject(project.id)
        .then((data) => {
          setSegments(data.segments || []);
        })
        .catch(() => {})
        .finally(() => setLoadingSegments(false));
    }
  }, [project?.id, uid]);

  const updateSegment = useCallback(
    (segmentId: string, patch: Partial<SubtitleSegment>) => {
      setSegments((prev) =>
        prev.map((seg) => {
          if (seg.id !== segmentId) return seg;
          const nextText = patch.text !== undefined ? patch.text : seg.text;
          const isEdited =
            patch.edited !== undefined
              ? patch.edited
              : nextText !== seg.originalText ||
                patch.start !== undefined ||
                patch.end !== undefined;
          return {
            ...seg,
            ...patch,
            text: nextText,
            lang: patch.lang || detectSegmentLanguage(nextText),
            edited: isEdited,
            editedBy: uid || 'local_editor',
          };
        })
      );
      setHasUnsavedChanges(true);
    },
    [uid]
  );

  const renameSpeakerAcrossSegments = useCallback(
    (oldSpeaker: string, newSpeaker: string) => {
      const trimmed = newSpeaker.trim().slice(0, 100);
      if (!trimmed || trimmed === oldSpeaker) return;
      setSegments((prev) =>
        prev.map((seg) =>
          seg.speaker === oldSpeaker
            ? { ...seg, speaker: trimmed, edited: true, editedBy: uid || 'local_editor' }
            : seg
        )
      );
      setHasUnsavedChanges(true);
    },
    [uid]
  );

  const revertSegment = useCallback((segmentId: string) => {
    setSegments((prev) =>
      prev.map((seg) => {
        if (seg.id !== segmentId) return seg;
        return {
          ...seg,
          text: seg.originalText,
          lang: detectSegmentLanguage(seg.originalText),
          edited: false,
          editedBy: '',
        };
      })
    );
    setHasUnsavedChanges(true);
  }, []);

  const splitSegment = useCallback(
    (segmentId: string, splitAtTime?: number) => {
      setSegments((prev) => {
        const idx = prev.findIndex((s) => s.id === segmentId);
        if (idx === -1) return prev;
        const target = prev[idx];
        const duration = target.end - target.start;
        if (duration < 0.6) return prev;

        const mid =
          splitAtTime && splitAtTime > target.start + 0.2 && splitAtTime < target.end - 0.2
            ? Number(splitAtTime.toFixed(2))
            : Number((target.start + duration / 2).toFixed(2));

        const words = target.text.trim().split(/\s+/);
        let firstText = target.text;
        let secondText = '...';
        if (words.length >= 2) {
          const half = Math.ceil(words.length / 2);
          firstText = words.slice(0, half).join(' ');
          secondText = words.slice(half).join(' ');
        } else if (target.text.length >= 4) {
          const halfChar = Math.ceil(target.text.length / 2);
          firstText = target.text.slice(0, halfChar);
          secondText = target.text.slice(halfChar);
        }

        const firstSeg: SubtitleSegment = {
          ...target,
          end: mid,
          text: firstText,
          lang: detectSegmentLanguage(firstText),
          edited: true,
          editedBy: uid || 'local_editor',
        };

        const secondSeg: SubtitleSegment = {
          ...target,
          id: `seg_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}`,
          start: mid,
          end: target.end,
          text: secondText,
          originalText: secondText,
          lang: detectSegmentLanguage(secondText),
          edited: true,
          editedBy: uid || 'local_editor',
        };

        const nextList = [...prev.slice(0, idx), firstSeg, secondSeg, ...prev.slice(idx + 1)];
        return nextList.map((s, i) => ({ ...s, index: i }));
      });
      setHasUnsavedChanges(true);
    },
    [uid]
  );

  const duplicateSegment = useCallback(
    (segmentId: string) => {
      setSegments((prev) => {
        const idx = prev.findIndex((s) => s.id === segmentId);
        if (idx === -1) return prev;
        const target = prev[idx];
        const dur = Math.max(1.5, Number((target.end - target.start).toFixed(2)));
        const copyStart = Number(target.end.toFixed(2));
        const copyEnd = Number((copyStart + dur).toFixed(2));

        const dupSeg: SubtitleSegment = {
          ...target,
          id: `seg_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}`,
          start: copyStart,
          end: copyEnd,
          edited: true,
          editedBy: uid || 'local_editor',
        };

        const nextList = [...prev.slice(0, idx + 1), dupSeg, ...prev.slice(idx + 1)];
        return nextList.map((s, i) => ({ ...s, index: i }));
      });
      setHasUnsavedChanges(true);
    },
    [uid]
  );

  const mergeWithNext = useCallback(
    (segmentId: string) => {
      setSegments((prev) => {
        const idx = prev.findIndex((s) => s.id === segmentId);
        if (idx === -1 || idx >= prev.length - 1) return prev;
        const current = prev[idx];
        const next = prev[idx + 1];
        deletedIdsRef.current.push(next.id);

        const mergedText = `${current.text.trim()} ${next.text.trim()}`.trim().slice(0, 1000);
        const merged: SubtitleSegment = {
          ...current,
          end: next.end,
          text: mergedText,
          lang: detectSegmentLanguage(mergedText),
          edited: true,
          editedBy: uid || 'local_editor',
        };

        const nextList = [...prev.slice(0, idx), merged, ...prev.slice(idx + 2)];
        return nextList.map((s, i) => ({ ...s, index: i }));
      });
      setHasUnsavedChanges(true);
    },
    [uid]
  );

  const deleteSegment = useCallback((segmentId: string) => {
    deletedIdsRef.current.push(segmentId);
    setSegments((prev) =>
      prev.filter((s) => s.id !== segmentId).map((s, i) => ({ ...s, index: i }))
    );
    setHasUnsavedChanges(true);
  }, []);

  const addSegmentAtTime = useCallback(
    (currentTime: number) => {
      setSegments((prev) => {
        const lastEnd = prev.length > 0 ? prev[prev.length - 1].end : 20.0;
        const start = Number((currentTime > 0.1 ? currentTime : lastEnd).toFixed(2));
        const end = Number((start + 4.0).toFixed(2));
        const newSeg: SubtitleSegment = {
          id: `seg_${Date.now().toString(36)}`,
          ownerId: uid || project?.ownerId || 'local',
          projectId: project?.id || 'proj_local',
          index: prev.length,
          start,
          end,
          text: 'Type your subtitle here...',
          originalText: 'Type your subtitle here...',
          speaker: 'Speaker 1',
          lang: 'en',
          confidence: 0.99,
          edited: true,
          editedBy: uid || 'local_editor',
        };
        const nextList = [...prev, newSeg].sort((a, b) => a.start - b.start);
        return nextList.map((s, i) => ({ ...s, index: i }));
      });
      setHasUnsavedChanges(true);
    },
    [project?.id, project?.ownerId, uid]
  );

  const shiftAllTimings = useCallback((offsetSeconds: number) => {
    if (!offsetSeconds) return;
    setSegments((prev) =>
      prev.map((seg) => ({
        ...seg,
        start: Number(Math.max(0, seg.start + offsetSeconds).toFixed(2)),
        end: Number(Math.max(0.2, seg.end + offsetSeconds).toFixed(2)),
        edited: true,
      }))
    );
    setHasUnsavedChanges(true);
  }, []);

  const replaceAllSegments = useCallback((newSegments: SubtitleSegment[]) => {
    setSegments(newSegments.map((s, idx) => ({ ...s, index: idx })));
    setHasUnsavedChanges(true);
  }, []);

  const saveAllSegments = useCallback(async () => {
    if (!project) return;
    setIsSaving(true);
    try {
      await syncSegmentsToBackend(project.id, segments);
      if (uid) {
        await batchSaveSegmentsToFirestore(
          project.id,
          uid,
          segments,
          deletedIdsRef.current
        );
        deletedIdsRef.current = [];
      }
      setHasUnsavedChanges(false);
      setLastSavedAt(
        new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    } finally {
      setIsSaving(false);
    }
  }, [project, segments, uid]);

  return {
    segments,
    exportsList,
    loadingSegments,
    isSaving,
    hasUnsavedChanges,
    lastSavedAt,
    updateSegment,
    renameSpeakerAcrossSegments,
    revertSegment,
    splitSegment,
    duplicateSegment,
    mergeWithNext,
    deleteSegment,
    addSegmentAtTime,
    shiftAllTimings,
    replaceAllSegments,
    saveAllSegments,
  };
}
