import React, { useState, useEffect } from 'react';
import {
  Scissors,
  Merge,
  RotateCcw,
  Trash2,
  Play,
  Copy,
} from 'lucide-react';
import { SubtitleSegment, VALIDATION_LIMITS } from '../../shared/segment.schema';
import { formatTimestampDisplay, formatTimestampHMS, parseTimeInput } from '../lib/srt';

interface SubtitleRowProps {
  segment: SubtitleSegment;
  isActive: boolean;
  isSelected?: boolean;
  isLast: boolean;
  onSeek: (time: number) => void;
  onSelect?: (id: string) => void;
  onUpdate: (id: string, patch: Partial<SubtitleSegment>) => void;
  onRevert: (id: string) => void;
  onSplit: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onMergeWithNext: (id: string) => void;
  onDelete: (id: string) => void;
}

export const SubtitleRow: React.FC<SubtitleRowProps> = ({
  segment,
  isActive,
  isSelected,
  isLast,
  onSeek,
  onSelect,
  onUpdate,
  onRevert,
  onSplit,
  onDuplicate,
  onMergeWithNext,
  onDelete,
}) => {
  const [startStr, setStartStr] = useState(formatTimestampDisplay(segment.start));
  const [endStr, setEndStr] = useState(formatTimestampDisplay(segment.end));

  useEffect(() => {
    setStartStr(formatTimestampDisplay(segment.start));
    setEndStr(formatTimestampDisplay(segment.end));
  }, [segment.start, segment.end]);

  const commitStart = () => {
    const parsed = parseTimeInput(startStr);
    if (parsed !== null && parsed < segment.end) {
      onUpdate(segment.id, { start: parsed });
    } else {
      setStartStr(formatTimestampDisplay(segment.start));
    }
  };

  const commitEnd = () => {
    const parsed = parseTimeInput(endStr);
    if (parsed !== null && parsed > segment.start) {
      onUpdate(segment.id, { end: parsed });
    } else {
      setEndStr(formatTimestampDisplay(segment.end));
    }
  };

  const durationSec = Math.max(0.1, segment.end - segment.start).toFixed(1);

  return (
    <div
      onClick={() => {
        if (onSelect) onSelect(segment.id);
      }}
      className={`p-3.5 rounded-xl border transition-all duration-200 ${
        isActive
          ? 'border-amber-400 bg-slate-900/95 shadow-[0_0_16px_rgba(251,191,36,0.18)]'
          : isSelected
            ? 'border-amber-400/50 bg-slate-900/75'
            : 'border-slate-800/90 bg-[#111827] hover:border-slate-700'
      }`}
    >
      {/* Top Row: Timestamp Jump Button, Start -> End Inputs, Speaker Label, and Metadata */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onSelect) onSelect(segment.id);
              onSeek(segment.start);
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono tabular-nums transition-colors whitespace-nowrap shrink-0 ${
              isActive
                ? 'bg-amber-400 text-slate-950 font-bold'
                : 'bg-slate-950 hover:bg-slate-800 text-amber-400 border border-slate-800'
            }`}
            title="Click to jump video directly to this timestamp"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>{formatTimestampHMS(segment.start)}</span>
          </button>

          <div className="flex items-center gap-1 font-mono text-xs tabular-nums">
            <input
              type="text"
              value={startStr}
              onChange={(e) => setStartStr(e.target.value)}
              onBlur={commitStart}
              aria-label="Start time"
              className="w-20 px-2 py-1 bg-slate-950 border border-slate-800 rounded text-slate-200 focus:outline-none focus:border-amber-400 text-center tabular-nums"
            />
            <span className="text-slate-600">→</span>
            <input
              type="text"
              value={endStr}
              onChange={(e) => setEndStr(e.target.value)}
              onBlur={commitEnd}
              aria-label="End time"
              className="w-20 px-2 py-1 bg-slate-950 border border-slate-800 rounded text-slate-200 focus:outline-none focus:border-amber-400 text-center tabular-nums"
            />
          </div>

          <select
            value={segment.speaker}
            onChange={(e) => onUpdate(segment.id, { speaker: e.target.value })}
            aria-label="Speaker"
            className="px-2 py-1 bg-slate-950 border border-slate-800 rounded text-xs font-medium text-slate-200 focus:outline-none focus:border-amber-400"
          >
            <option value="Speaker 1">Speaker 1</option>
            <option value="Speaker 2">Speaker 2</option>
            <option value="Speaker 3">Speaker 3</option>
            <option value="Narrator">Narrator</option>
            <option value="Host">Host</option>
          </select>
        </div>

        {/* Clean Unboxed Metadata */}
        <div className="flex items-center gap-1.5 text-xs text-slate-400 font-mono tabular-nums">
          <span>#{String(segment.index + 1).padStart(2, '0')}</span>
          <span aria-hidden="true">·</span>
          <span>{durationSec}s</span>
          <span aria-hidden="true">·</span>
          <span className="uppercase">{segment.lang}</span>
          {segment.edited && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-300 font-sans">Edited</span>
            </>
          )}
        </div>
      </div>

      {/* Subtitle Textarea with Khmer Font Support */}
      <textarea
        rows={2}
        maxLength={VALIDATION_LIMITS.SEGMENT_TEXT_MAX_LEN}
        value={segment.text}
        onChange={(e) => onUpdate(segment.id, { text: e.target.value })}
        style={{ fontFamily: '"Battambang", "Noto Sans Khmer", "Plus Jakarta Sans", sans-serif' }}
        className="w-full px-3 py-2 bg-slate-950/90 border border-slate-800 rounded-lg text-sm text-slate-100 leading-relaxed focus:outline-none focus:border-amber-400 resize-none"
        placeholder="Type your subtitle here..."
      />

      {/* Footer Actions: Split, Merge, Duplicate, Revert, Delete */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-2 pt-1">
        <div className="text-xs text-slate-500 truncate max-w-xs font-mono tabular-nums">
          {segment.text.length} chars
        </div>

        <div className="flex items-center gap-1.5">
          {segment.edited && (
            <button
              type="button"
              onClick={() => onRevert(segment.id)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
              title="Revert to original ASR text"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Revert</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onSplit(segment.id)}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
            title="Split at Current Time"
          >
            <Scissors className="w-3 h-3" />
            <span>Split</span>
          </button>

          {!isLast && (
            <button
              type="button"
              onClick={() => onMergeWithNext(segment.id)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
              title="Merge with next subtitle"
            >
              <Merge className="w-3 h-3" />
              <span>Merge</span>
            </button>
          )}

          {onDuplicate && (
            <button
              type="button"
              onClick={() => onDuplicate(segment.id)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
              title="Duplicate subtitle"
            >
              <Copy className="w-3 h-3" />
              <span>Duplicate</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onDelete(segment.id)}
            className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-900 rounded transition-colors"
            title="Delete subtitle"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
