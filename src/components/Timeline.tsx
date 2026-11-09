import React, { useRef, useState, useEffect, useMemo } from 'react';
import {
  Plus,
  Scissors,
  Subtitles,
  Undo2,
  Redo2,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Volume2,
  VolumeX,
  Link2,
  Film,
  ChevronDown,
  Music,
  Merge,
  Copy,
  Trash2,
} from 'lucide-react';
import {
  CaptionFont,
  SubtitleSegment,
  VideoAspectRatio,
  WordsPerSegmentOption,
  resolveFontFamilyCss,
} from '../../shared/segment.schema';
import { formatTimestampDisplay } from '../lib/srt';

interface TimelineProps {
  segments: SubtitleSegment[];
  durationSec: number;
  currentTime: number;
  videoUrl?: string;
  activeFont?: CaptionFont;
  customFontName?: string;
  templateName?: string;
  aspectRatio?: VideoAspectRatio;
  captionsVisible?: boolean;
  videoVisible?: boolean;
  activeSegmentId: string | null;
  selectedSegmentId?: string | null;
  onSeek: (time: number) => void;
  onSelectSegment?: (segmentId: string) => void;
  onUpdateSegmentTiming?: (segmentId: string, start: number, end: number) => void;
  onAddSegmentAtCurrentTime?: (time: number) => void;
  onSplitSegment?: (segmentId: string) => void;
  onMergeSegment?: (segmentId: string) => void;
  onDuplicateSegment?: (segmentId: string) => void;
  onDeleteSegment?: (segmentId: string) => void;
  onRegroupWords?: (words: WordsPerSegmentOption) => void;
  onChangeAspectRatio?: (ratio: VideoAspectRatio) => void;
  onToggleCaptionsVisible?: () => void;
  onToggleVideoVisible?: () => void;
}

type DragState = {
  segmentId: string;
  mode: 'move' | 'resize-left' | 'resize-right';
  initialX: number;
  initialStart: number;
  initialEnd: number;
};

/**
 * Formats seconds as M:SS (e.g. 0:12, 0:23) for ruler ticks
 */
function formatRulerTick(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

/**
 * Formats seconds as M:SS.cc (e.g. 0:23.01) for the playhead pill & header
 */
function formatPlayheadTime(sec: number): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${mins}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export const Timeline: React.FC<TimelineProps> = ({
  segments,
  durationSec,
  currentTime,
  videoUrl,
  activeFont = 'Battambang',
  customFontName,
  templateName = 'Outline head...',
  aspectRatio = 'original',
  captionsVisible = true,
  videoVisible = true,
  activeSegmentId,
  selectedSegmentId,
  onSeek,
  onSelectSegment,
  onUpdateSegmentTiming,
  onAddSegmentAtCurrentTime,
  onSplitSegment,
  onMergeSegment,
  onDuplicateSegment,
  onDeleteSegment,
  onRegroupWords,
  onChangeAspectRatio,
  onToggleCaptionsVisible,
  onToggleVideoVisible,
}) => {
  const laneContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [isScrubbingPlayhead, setIsScrubbingPlayhead] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1.8); // 1x to 5x
  const [captionsLocked, setCaptionsLocked] = useState(false);
  const [videoLocked, setVideoLocked] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [showAudioTrack, setShowAudioTrack] = useState(false);
  const [customAudioName, setCustomAudioName] = useState<string | null>(null);

  // Dropdown menus
  const [openMenu, setOpenMenu] = useState<'add' | 'edit' | 'captions' | 'view' | null>(null);

  // Undo / Redo history stack for segment timing moves
  const [historyStack, setHistoryStack] = useState<
    { id: string; start: number; end: number }[]
  >([]);
  const [redoStack, setRedoStack] = useState<{ id: string; start: number; end: number }[]>([]);

  // Filmstrip thumbnails extracted from videoUrl
  const [thumbnails, setThumbnails] = useState<string[]>([]);

  const clipDuration = Math.max(durationSec || 18, 4);
  // Timeline extends ~45% past the end of the clip (e.g. 23s clip -> 34s timeline ruler) just like the studio screenshot
  const timelineTotalSec = useMemo(
    () => Math.max(clipDuration + 11, Math.ceil(clipDuration * 1.48)),
    [clipDuration]
  );

  // Extract 14 real video frame thumbnails from videoUrl using an offscreen video + canvas
  useEffect(() => {
    if (!videoUrl) {
      setThumbnails([]);
      return;
    }
    let cancelled = false;
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.src = videoUrl;

    const extractFrames = async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error('video load failed'));
        });
        const dur = Math.max(1, video.duration || clipDuration);
        const count = 14;
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 54;
        const ctx = canvas.getContext('2d');
        const frames: string[] = [];

        for (let i = 0; i < count; i++) {
          if (cancelled) return;
          const targetTime = Math.min(dur - 0.05, (i / count) * dur + 0.1);
          video.currentTime = targetTime;
          await new Promise<void>((resolve) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              resolve();
            };
            video.addEventListener('seeked', onSeeked);
            setTimeout(resolve, 250);
          });
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push(canvas.toDataURL('image/jpeg', 0.65));
          }
        }
        if (!cancelled && frames.length > 0) {
          setThumbnails(frames);
        }
      } catch {
        // Fallback pattern if canvas extraction fails
      }
    };

    extractFrames();
    return () => {
      cancelled = true;
      video.src = '';
    };
  }, [videoUrl, clipDuration]);

  const computeTimeFromClientX = (clientX: number): number => {
    if (!laneContainerRef.current) return currentTime;
    const rect = laneContainerRef.current.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const time = (relX / Math.max(1, rect.width)) * timelineTotalSec;
    return Number(Math.max(0, Math.min(clipDuration, time)).toFixed(2));
  };

  const handleRulerOrLaneMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragState) return;
    setOpenMenu(null);
    setIsScrubbingPlayhead(true);
    onSeek(computeTimeFromClientX(e.clientX));
  };

  const startDrag = (
    e: React.MouseEvent,
    seg: SubtitleSegment,
    mode: 'move' | 'resize-left' | 'resize-right'
  ) => {
    e.stopPropagation();
    setOpenMenu(null);
    if (onSelectSegment) onSelectSegment(seg.id);
    if (captionsLocked) return;

    setHistoryStack((prev) => [
      ...prev.slice(-19),
      { id: seg.id, start: seg.start, end: seg.end },
    ]);
    setRedoStack([]);

    setDragState({
      segmentId: seg.id,
      mode,
      initialX: e.clientX,
      initialStart: seg.start,
      initialEnd: seg.end,
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isScrubbingPlayhead) {
      onSeek(computeTimeFromClientX(e.clientX));
      return;
    }
    if (!dragState || !laneContainerRef.current || !onUpdateSegmentTiming) return;
    const rect = laneContainerRef.current.getBoundingClientRect();
    const deltaX = e.clientX - dragState.initialX;
    const deltaSec = (deltaX / Math.max(1, rect.width)) * timelineTotalSec;

    const dur = dragState.initialEnd - dragState.initialStart;
    if (dragState.mode === 'move') {
      const nextStart = Number(
        Math.max(0, Math.min(clipDuration - dur, dragState.initialStart + deltaSec)).toFixed(2)
      );
      const nextEnd = Number((nextStart + dur).toFixed(2));
      onUpdateSegmentTiming(dragState.segmentId, nextStart, nextEnd);
    } else if (dragState.mode === 'resize-left') {
      const nextStart = Number(
        Math.max(0, Math.min(dragState.initialEnd - 0.2, dragState.initialStart + deltaSec)).toFixed(2)
      );
      onUpdateSegmentTiming(dragState.segmentId, nextStart, dragState.initialEnd);
    } else if (dragState.mode === 'resize-right') {
      const nextEnd = Number(
        Math.max(dragState.initialStart + 0.2, Math.min(clipDuration, dragState.initialEnd + deltaSec)).toFixed(2)
      );
      onUpdateSegmentTiming(dragState.segmentId, dragState.initialStart, nextEnd);
    }
  };

  const endInteraction = () => {
    if (dragState) setDragState(null);
    if (isScrubbingPlayhead) setIsScrubbingPlayhead(false);
  };

  const handleUndo = () => {
    if (historyStack.length === 0 || !onUpdateSegmentTiming) return;
    const last = historyStack[historyStack.length - 1];
    const currentSeg = segments.find((s) => s.id === last.id);
    if (currentSeg) {
      setRedoStack((r) => [
        ...r,
        { id: currentSeg.id, start: currentSeg.start, end: currentSeg.end },
      ]);
    }
    onUpdateSegmentTiming(last.id, last.start, last.end);
    setHistoryStack((prev) => prev.slice(0, -1));
  };

  const handleRedo = () => {
    if (redoStack.length === 0 || !onUpdateSegmentTiming) return;
    const next = redoStack[redoStack.length - 1];
    const currentSeg = segments.find((s) => s.id === next.id);
    if (currentSeg) {
      setHistoryStack((h) => [
        ...h,
        { id: currentSeg.id, start: currentSeg.start, end: currentSeg.end },
      ]);
    }
    onUpdateSegmentTiming(next.id, next.start, next.end);
    setRedoStack((prev) => prev.slice(0, -1));
  };

  // Generate ruler ticks based on zoom level and total seconds
  const tickStepSec = useMemo(() => {
    if (timelineTotalSec <= 45 && zoomLevel >= 1.4) return 1;
    if (timelineTotalSec <= 90) return 2;
    if (timelineTotalSec <= 240) return 5;
    return 10;
  }, [timelineTotalSec, zoomLevel]);

  const rulerTicks = useMemo(() => {
    const arr: number[] = [];
    for (let t = 0; t <= timelineTotalSec; t += tickStepSec) {
      arr.push(t);
    }
    return arr;
  }, [timelineTotalSec, tickStepSec]);

  const playheadPct = Math.max(0, Math.min(100, (currentTime / timelineTotalSec) * 100));
  const clipWidthPct = Math.max(5, Math.min(100, (clipDuration / timelineTotalSec) * 100));

  const targetSegmentId = selectedSegmentId || activeSegmentId || segments[0]?.id || null;

  return (
    <div
      onMouseMove={handleMouseMove}
      onMouseUp={endInteraction}
      onMouseLeave={endInteraction}
      className="border border-[#1E1E2A] bg-[#0B0B10] rounded-xl overflow-hidden select-none shadow-2xl"
    >
      {/* 1. TOP STUDIO TIMELINE TOOLBAR (+ Add | Edit | Captions | Undo/Redo | Aspect Ratio | View | Zoom) */}
      <div className="relative flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 bg-[#0B0B10] border-b border-[#1C1C26] text-xs text-zinc-200">
        {/* Left Action Group */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* + Add Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'add' ? null : 'add')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[#1A1A24] text-zinc-200 font-medium transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-zinc-300" />
              <span>Add</span>
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            </button>
            {openMenu === 'add' && (
              <div className="absolute left-0 top-full mt-1 w-52 bg-[#161621] border border-[#2A2A3C] rounded-lg shadow-xl py-1 z-50">
                <button
                  type="button"
                  onClick={() => {
                    if (onAddSegmentAtCurrentTime) onAddSegmentAtCurrentTime(currentTime);
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  <Subtitles className="w-3.5 h-3.5 text-purple-400" />
                  <span>+ Add Caption at {formatPlayheadTime(currentTime)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAudioTrack(true);
                    audioInputRef.current?.click();
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  <Music className="w-3.5 h-3.5 text-purple-400" />
                  <span>+ Add Music or Voiceover</span>
                </button>
              </div>
            )}
          </div>

          {/* ✂ Edit Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[#1A1A24] text-zinc-200 font-medium transition-colors"
            >
              <Scissors className="w-3.5 h-3.5 text-zinc-300" />
              <span>Edit</span>
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            </button>
            {openMenu === 'edit' && (
              <div className="absolute left-0 top-full mt-1 w-52 bg-[#161621] border border-[#2A2A3C] rounded-lg shadow-xl py-1 z-50">
                <button
                  type="button"
                  onClick={() => {
                    if (targetSegmentId && onSplitSegment) onSplitSegment(targetSegmentId);
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  <Scissors className="w-3.5 h-3.5 text-amber-400" />
                  <span>Split Caption at Playhead</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (targetSegmentId && onMergeSegment) onMergeSegment(targetSegmentId);
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  <Merge className="w-3.5 h-3.5 text-sky-400" />
                  <span>Merge with Next Caption</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (targetSegmentId && onDuplicateSegment) onDuplicateSegment(targetSegmentId);
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  <Copy className="w-3.5 h-3.5 text-zinc-300" />
                  <span>Duplicate Caption</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (targetSegmentId && onDeleteSegment) onDeleteSegment(targetSegmentId);
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-rose-400 hover:bg-rose-950/50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Caption</span>
                </button>
              </div>
            )}
          </div>

          {/* 💬 Captions Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'captions' ? null : 'captions')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[#1A1A24] text-zinc-200 font-medium transition-colors"
            >
              <Subtitles className="w-3.5 h-3.5 text-zinc-300" />
              <span>Captions</span>
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            </button>
            {openMenu === 'captions' && (
              <div className="absolute left-0 top-full mt-1 w-56 bg-[#161621] border border-[#2A2A3C] rounded-lg shadow-xl py-1 z-50">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Word Density Grouping
                </div>
                {(
                  [
                    { val: 1, label: 'Regroup: 1 Word per Caption' },
                    { val: 2, label: 'Regroup: 2 Words per Caption' },
                    { val: 3, label: 'Regroup: 3 Words per Caption' },
                    { val: 4, label: 'Regroup: 4 Words per Caption' },
                  ] as { val: WordsPerSegmentOption; label: string }[]
                ).map((item) => (
                  <button
                    key={item.val}
                    type="button"
                    onClick={() => {
                      if (onRegroupWords) onRegroupWords(item.val);
                      setOpenMenu(null);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                  >
                    <span>{item.label}</span>
                    <span className="font-mono text-[10px] text-purple-300">{item.val}W</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-[#262636] mx-1" />

          {/* Undo / Redo */}
          <button
            type="button"
            onClick={handleUndo}
            disabled={historyStack.length === 0}
            title="Undo timing change"
            className="p-1.5 rounded-md hover:bg-[#1A1A24] text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            title="Redo timing change"
            className="p-1.5 rounded-md hover:bg-[#1A1A24] text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Center Video Aspect Ratio Quick Selector */}
        {onChangeAspectRatio && (
          <div className="hidden md:flex items-center gap-1 bg-[#13131C] px-2 py-1 rounded-lg border border-[#222230]">
            <span className="text-[11px] text-zinc-400 mr-1">Ratio:</span>
            {(
              [
                { id: 'original', label: 'Original' },
                { id: '9:16', label: '9:16' },
                { id: '16:9', label: '16:9' },
                { id: '1:1', label: '1:1' },
                { id: '4:5', label: '4:5' },
              ] as { id: VideoAspectRatio; label: string }[]
            ).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onChangeAspectRatio(r.id)}
                className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                  aspectRatio === r.id
                    ? 'bg-[#2B1644] text-white border border-[#9353D3]'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {/* Right View + Zoom Slider */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[#1A1A24] text-zinc-300 font-medium transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>View</span>
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            </button>
            {openMenu === 'view' && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-[#161621] border border-[#2A2A3C] rounded-lg shadow-xl py-1 z-50">
                <button
                  type="button"
                  onClick={() => {
                    setZoomLevel(1);
                    setOpenMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  Fit Timeline to Window
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setZoomLevel(2.5);
                    setOpenMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  1-Second Detail Zoom
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAudioTrack((v) => !v);
                    setOpenMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-[#2B1644]"
                >
                  {showAudioTrack ? 'Hide Audio Track' : 'Show Audio Track'}
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setZoomLevel((z) => Math.max(1, Number((z - 0.4).toFixed(1))))}
            title="Zoom Out Timeline"
            className="p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>

          <input
            type="range"
            min={1}
            max={5}
            step={0.1}
            value={zoomLevel}
            onChange={(e) => setZoomLevel(Number.parseFloat(e.target.value))}
            className="w-24 h-1 rounded-lg appearance-none cursor-pointer accent-[#9353D3] bg-[#272736]"
          />

          <button
            type="button"
            onClick={() => setZoomLevel((z) => Math.min(5, Number((z + 0.4).toFixed(1))))}
            title="Zoom In Timeline"
            className="p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 2. MULTI-TRACK TIMELINE BODY (LEFT HEADERS + RIGHT SCROLLABLE LANES) */}
      <div className="flex w-full">
        {/* LEFT COLUMN: FIXED TRACK HEADERS */}
        <div className="w-44 sm:w-48 shrink-0 bg-[#0B0B10] border-r border-[#1C1C26] flex flex-col z-20">
          {/* Top-left duration & clip count cell */}
          <div className="h-7 px-3 flex items-center border-b border-[#1C1C26] text-[11px] font-mono text-zinc-400 tabular-nums">
            {formatPlayheadTime(clipDuration)} · 1 clips
          </div>

          {/* Track 1 Header: Captions */}
          <div className="h-12 px-2.5 flex flex-col justify-center border-b border-[#181822] relative">
            <div className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-[#8B5CF6]" />
            <div className="flex items-center justify-between gap-1 pl-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <Subtitles className="w-3.5 h-3.5 text-zinc-300 shrink-0" />
                <span className="text-xs font-semibold text-zinc-100 truncate">Captions</span>
                <span
                  title="Synced to Transcript"
                  className="inline-flex items-center justify-center w-4 h-3.5 rounded-full bg-[#6D28D9] text-white shrink-0"
                >
                  <Link2 className="w-2.5 h-2.5" />
                </span>
              </div>
              <div className="flex items-center gap-1 text-zinc-400 shrink-0">
                <button
                  type="button"
                  onClick={onToggleCaptionsVisible}
                  title={captionsVisible ? 'Hide Captions' : 'Show Captions'}
                  className="p-0.5 hover:text-white transition-colors"
                >
                  {captionsVisible ? (
                    <Eye className="w-3.5 h-3.5" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-rose-400" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setCaptionsLocked((v) => !v)}
                  title={captionsLocked ? 'Unlock Captions Track' : 'Lock Captions Track'}
                  className="p-0.5 hover:text-white transition-colors"
                >
                  {captionsLocked ? (
                    <Lock className="w-3.5 h-3.5 text-amber-400" />
                  ) : (
                    <Unlock className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
            <div className="pl-1.5 text-[10px] text-zinc-500 truncate mt-0.5">
              {segments.length} captions · {templateName}
            </div>
          </div>

          {/* Track 2 Header: Video */}
          <div className="h-14 px-2.5 flex flex-col justify-center border-b border-[#181822] relative">
            <div className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-[#C4B5FD]" />
            <div className="flex items-center justify-between gap-1 pl-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <Film className="w-3.5 h-3.5 text-zinc-300 shrink-0" />
                <span className="text-xs font-semibold text-zinc-100 truncate">Video</span>
              </div>
              <div className="flex items-center gap-1 text-zinc-400 shrink-0">
                <button
                  type="button"
                  onClick={() => setVideoMuted((m) => !m)}
                  title={videoMuted ? 'Unmute Clip' : 'Mute Clip'}
                  className="p-0.5 hover:text-white transition-colors"
                >
                  {videoMuted ? (
                    <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={onToggleVideoVisible}
                  title={videoVisible ? 'Hide Video Track' : 'Show Video Track'}
                  className="p-0.5 hover:text-white transition-colors"
                >
                  {videoVisible ? (
                    <Eye className="w-3.5 h-3.5" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-rose-400" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setVideoLocked((v) => !v)}
                  title={videoLocked ? 'Unlock Video Track' : 'Lock Video Track'}
                  className="p-0.5 hover:text-white transition-colors"
                >
                  {videoLocked ? (
                    <Lock className="w-3.5 h-3.5 text-amber-400" />
                  ) : (
                    <Unlock className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
            <div className="pl-1.5 text-[10px] text-zinc-500 truncate mt-0.5">
              1 clip · {clipDuration.toFixed(1)}s
            </div>
          </div>

          {/* Track 3 Header: + Add track */}
          <div className="h-11 px-2.5 flex items-center">
            <button
              type="button"
              onClick={() => {
                setShowAudioTrack(true);
                audioInputRef.current?.click();
              }}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-dashed border-[#2E2E42] hover:border-zinc-500 text-[11px] font-medium text-zinc-300 hover:text-white transition-colors"
            >
              <Plus className="w-3 h-3" />
              <span>Add track</span>
            </button>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setCustomAudioName(f.name);
                  setShowAudioTrack(true);
                }
              }}
            />
          </div>
        </div>

        {/* RIGHT COLUMN: SCROLLABLE RULER & MULTI-TRACK LANES */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-x-auto overflow-y-hidden relative bg-[#0B0B10]"
        >
          <div
            ref={laneContainerRef}
            onMouseDown={handleRulerOrLaneMouseDown}
            style={{
              width: `${Math.max(100, Math.round(zoomLevel * 100))}%`,
              minWidth: '100%',
            }}
            className="relative flex flex-col cursor-pointer"
          >
            {/* Diagonal Hatched Pattern beyond Clip End (e.g. after 0:23.01) */}
            <div
              style={{
                left: `${clipWidthPct}%`,
                width: `${Math.max(0, 100 - clipWidthPct)}%`,
                backgroundImage:
                  'repeating-linear-gradient(-45deg, #0B0B10, #0B0B10 6px, #13131D 6px, #13131D 12px)',
              }}
              className="pointer-events-none absolute top-7 bottom-0 z-0 opacity-85"
            />

            {/* A. TIME RULER ROW (0:12  0:13  0:14 ... 0:23.01 ... 0:34) */}
            <div className="relative h-7 bg-[#0E0E16] border-b border-[#1C1C26] flex items-center">
              {rulerTicks.map((t) => {
                const leftPct = (t / timelineTotalSec) * 100;
                if (leftPct > 99.5) return null;
                return (
                  <div
                    key={t}
                    style={{ left: `${leftPct}%` }}
                    className="absolute top-0 bottom-0 flex flex-col justify-between items-start pointer-events-none"
                  >
                    <span className="text-[10px] font-mono text-zinc-400 tabular-nums -ml-2.5 pt-1">
                      {formatRulerTick(t)}
                    </span>
                    <div className="h-1.5 w-px bg-[#2A2A3A]" />
                  </div>
                );
              })}
            </div>

            {/* B. TRACK 1 LANE: CAPTIONS (Rounded Purple Pills with Khmer Text) */}
            <div className="relative h-12 border-b border-[#181822] bg-[#0B0B10]/90">
              {segments.map((seg) => {
                const leftPct = Math.max(0, Math.min(99.5, (seg.start / timelineTotalSec) * 100));
                const widthPct = Math.max(
                  1.2,
                  Math.min(100 - leftPct, ((seg.end - seg.start) / timelineTotalSec) * 100)
                );
                const isActive = seg.id === activeSegmentId;
                const isSelected = seg.id === selectedSegmentId;

                return (
                  <div
                    key={seg.id}
                    onMouseDown={(e) => startDrag(e, seg, 'move')}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onSelectSegment) onSelectSegment(seg.id);
                      onSeek(seg.start);
                    }}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                    }}
                    title={`[${formatTimestampDisplay(seg.start)} → ${formatTimestampDisplay(seg.end)}] ${seg.text}`}
                    className={`group absolute top-1.5 bottom-1.5 rounded-full px-2.5 flex items-center overflow-hidden border transition-all duration-100 ${
                      captionsLocked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                    } ${
                      isActive || isSelected
                        ? 'bg-[#4C327A] border-[#C084FC] text-white shadow-[0_0_12px_rgba(168,85,247,0.35)] z-10'
                        : 'bg-[#352B4D]/95 border-[#63518F] text-zinc-100 hover:border-[#9378D4]'
                    }`}
                  >
                    {/* Left Resize Handle */}
                    {!captionsLocked && (
                      <div
                        onMouseDown={(e) => startDrag(e, seg, 'resize-left')}
                        title="Drag left edge to adjust start time"
                        className="absolute left-0 top-0 bottom-0 w-2 bg-purple-400/0 group-hover:bg-purple-300/50 cursor-ew-resize z-20"
                      />
                    )}

                    <span
                      className="text-[11px] font-medium truncate leading-none"
                      style={{
                        fontFamily: resolveFontFamilyCss(activeFont, customFontName),
                      }}
                    >
                      {seg.text}
                    </span>

                    {/* Right Resize Handle */}
                    {!captionsLocked && (
                      <div
                        onMouseDown={(e) => startDrag(e, seg, 'resize-right')}
                        title="Drag right edge to adjust end time"
                        className="absolute right-0 top-0 bottom-0 w-2 bg-purple-400/0 group-hover:bg-purple-300/50 cursor-ew-resize z-20"
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* C. TRACK 2 LANE: VIDEO FILMSTRIP THUMBNAILS */}
            <div className="relative h-14 border-b border-[#181822] bg-[#0B0B10]/90">
              <div
                style={{ width: `${clipWidthPct}%` }}
                className={`absolute left-0 top-1.5 bottom-1.5 rounded-lg overflow-hidden border border-[#323246] bg-[#161622] flex items-stretch ${
                  videoVisible ? 'opacity-100' : 'opacity-40'
                }`}
              >
                {thumbnails.length > 0 ? (
                  thumbnails.map((src, idx) => (
                    <div
                      key={idx}
                      className="flex-1 h-full overflow-hidden border-r border-black/30 last:border-r-0"
                    >
                      <img
                        src={src}
                        alt=""
                        draggable={false}
                        className="w-full h-full object-cover pointer-events-none"
                      />
                    </div>
                  ))
                ) : (
                  // Instant filmstrip frame placeholders while canvas thumbnails extract
                  Array.from({ length: 14 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="flex-1 h-full border-r border-white/5 bg-gradient-to-b from-[#1E1E2E] via-[#151521] to-[#1E1E2E] flex items-center justify-center"
                    >
                      <span className="text-[9px] font-mono text-zinc-600">
                        {formatRulerTick((idx / 14) * clipDuration)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* D. TRACK 3 LANE: + Add music or a voiceover */}
            <div className="relative h-11 flex items-center px-1">
              {showAudioTrack ? (
                <div
                  style={{ width: `${clipWidthPct}%` }}
                  className="h-8 rounded-full bg-[#192B24] border border-emerald-500/40 px-3 flex items-center justify-between gap-2 overflow-hidden"
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-emerald-300 font-medium truncate">
                    <Music className="w-3 h-3 shrink-0" />
                    <span className="truncate">
                      {customAudioName || 'Original Audio Stream (16kHz Stereo)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 h-4 opacity-55">
                    {Array.from({ length: 48 }).map((_, i) => (
                      <div
                        key={i}
                        className="w-0.5 bg-emerald-400 rounded-full"
                        style={{ height: `${25 + ((i * 23) % 70)}%` }}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAudioTrack(true);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-1 rounded-full border border-dashed border-[#2E2E42] hover:border-zinc-500 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add music or a voiceover</span>
                </button>
              )}
            </div>

            {/* E. PLAYHEAD TIME PILL (0:23.01) & VERTICAL WHITE NEEDLE */}
            <div
              style={{ left: `${playheadPct}%` }}
              className="pointer-events-none absolute top-0 bottom-0 z-30"
            >
              {/* White timecode badge on the ruler */}
              <div className="-translate-x-1/2 mt-1 px-1.5 py-0.5 rounded-[4px] bg-white text-[#09090D] font-mono text-[10px] font-bold leading-none shadow-md whitespace-nowrap">
                {formatPlayheadTime(currentTime)}
              </div>
              {/* Crisp vertical needle line */}
              <div className="w-[1.5px] h-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)] mx-auto" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
