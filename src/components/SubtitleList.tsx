import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  Search,
  Save,
  Upload as UploadIcon,
  Clock,
  Check,
  Plus,
  Copy,
  Users,
  Play,
  Edit3,
  Type as TypeIcon,
} from 'lucide-react';
import { SubtitleSegment, WordsPerSegmentOption } from '../../shared/segment.schema';
import { SubtitleRow } from './SubtitleRow';
import {
  buildTxt,
  formatTimestampShort,
  parseSrt,
  regroupSegmentsByWordCount,
} from '../lib/srt';

interface SubtitleListProps {
  projectId: string;
  ownerId: string;
  segments: SubtitleSegment[];
  activeSegmentId: string | null;
  selectedSegmentId?: string | null;
  currentTime: number;
  isSaving: boolean;
  hasUnsavedChanges: boolean;
  lastSavedAt: string | null;
  onSeek: (time: number) => void;
  onSelectSegment?: (id: string) => void;
  onUpdateSegment: (id: string, patch: Partial<SubtitleSegment>) => void;
  onRenameSpeaker?: (oldName: string, newName: string) => void;
  onRevertSegment: (id: string) => void;
  onSplitSegment: (id: string) => void;
  onDuplicateSegment?: (id: string) => void;
  onMergeWithNext: (id: string) => void;
  onDeleteSegment: (id: string) => void;
  onAddSegmentAtTime: (time: number) => void;
  onShiftAllTimings: (offsetSec: number) => void;
  onReplaceAllSegments: (newSegs: SubtitleSegment[]) => void;
  onSaveAll: () => Promise<void>;
}

type FilterMode = 'all' | 'km' | 'en' | 'mixed' | 'edited';

export const SubtitleList: React.FC<SubtitleListProps> = ({
  projectId,
  ownerId,
  segments,
  activeSegmentId,
  selectedSegmentId,
  currentTime,
  isSaving,
  hasUnsavedChanges,
  lastSavedAt,
  onSeek,
  onSelectSegment,
  onUpdateSegment,
  onRenameSpeaker,
  onRevertSegment,
  onSplitSegment,
  onDuplicateSegment,
  onMergeWithNext,
  onDeleteSegment,
  onAddSegmentAtTime,
  onShiftAllTimings,
  onReplaceAllSegments,
  onSaveAll,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [wordsMode, setWordsMode] = useState<WordsPerSegmentOption>(0);
  const [shiftOffset, setShiftOffset] = useState('0.5');
  const [showShiftBar, setShowShiftBar] = useState(false);
  const [showSpeakerManager, setShowSpeakerManager] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [newSpeakerName, setNewSpeakerName] = useState('');
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Preserve original phrase-level segments so switching 1W / 2W / 3W / 4W / Full Line is non-destructive
  const basePhraseSegmentsRef = useRef<SubtitleSegment[]>([]);

  useEffect(() => {
    setWordsMode(0);
    basePhraseSegmentsRef.current = [];
  }, [projectId]);

  useEffect(() => {
    if (wordsMode === 0 && segments.length > 0 && basePhraseSegmentsRef.current.length === 0) {
      basePhraseSegmentsRef.current = segments;
    }
  }, [segments, wordsMode]);

  const handleSelectWordGrouping = (targetWords: WordsPerSegmentOption) => {
    if (segments.length === 0) return;
    if (wordsMode === 0 && basePhraseSegmentsRef.current.length === 0) {
      basePhraseSegmentsRef.current = [...segments];
    }
    const sourceSegments =
      basePhraseSegmentsRef.current.length > 0 ? basePhraseSegmentsRef.current : segments;

    setWordsMode(targetWords);
    if (targetWords === 0) {
      onReplaceAllSegments(sourceSegments);
    } else {
      const regrouped = regroupSegmentsByWordCount(sourceSegments, targetWords);
      onReplaceAllSegments(regrouped);
    }
  };

  const distinctSpeakers = useMemo(() => {
    return Array.from(new Set(segments.map((s) => s.speaker || 'Speaker 1')));
  }, [segments]);

  const filteredSegments = segments.filter((seg) => {
    if (filterMode === 'km' && seg.lang !== 'km') return false;
    if (filterMode === 'en' && seg.lang !== 'en') return false;
    if (filterMode === 'mixed' && seg.lang !== 'mixed') return false;
    if (filterMode === 'edited' && !seg.edited) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        seg.text.toLowerCase().includes(q) ||
        seg.speaker.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleImportSrtFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseSrt(text, projectId, ownerId);
    if (parsed.length > 0) {
      basePhraseSegmentsRef.current = parsed;
      setWordsMode(0);
      onReplaceAllSegments(parsed);
    }
    e.target.value = '';
  };

  const handleCopyFullTranscript = async () => {
    const txt = buildTxt(segments);
    await navigator.clipboard.writeText(txt);
    setCopiedTranscript(true);
    window.setTimeout(() => setCopiedTranscript(false), 1800);
  };

  const applyTimeShift = (direction: 1 | -1) => {
    const val = Number.parseFloat(shiftOffset);
    if (Number.isFinite(val) && val > 0) {
      onShiftAllTimings(val * direction);
    }
  };

  const commitSpeakerRename = (oldName: string) => {
    if (onRenameSpeaker && newSpeakerName.trim()) {
      onRenameSpeaker(oldName, newSpeakerName.trim());
    }
    setEditingSpeaker(null);
    setNewSpeakerName('');
  };

  return (
    <div className="flex flex-col h-full border border-slate-800 bg-[#111827] rounded-xl overflow-hidden">
      {/* TRANSCRIPT Header Bar: Search, Edit/Speakers, Play, Copy, Save */}
      <div className="p-4 border-b border-slate-800 bg-[#0F1522] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-slate-100">TRANSCRIPT & SRT</h2>
              <span className="text-xs text-amber-400 font-medium">
                Khmer + English
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums mt-0.5">
              <span>{segments.length} segments</span>
              <span aria-hidden="true">·</span>
              <span>{distinctSpeakers.length} speakers</span>
              {lastSavedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Saved {lastSavedAt}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowSpeakerManager((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              title="Automatic Speaker Detection & Rename"
            >
              <Users className="w-3.5 h-3.5 text-amber-400" />
              <span>Speakers</span>
            </button>

            <button
              type="button"
              onClick={handleCopyFullTranscript}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{copiedTranscript ? 'Copied!' : 'Copy'}</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".srt"
              onChange={handleImportSrtFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <UploadIcon className="w-3.5 h-3.5" />
              <span>Import SRT</span>
            </button>

            <button
              type="button"
              onClick={() => setShowShiftBar((prev) => !prev)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Timing</span>
            </button>

            <button
              type="button"
              onClick={onSaveAll}
              disabled={isSaving}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                hasUnsavedChanges
                  ? 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                  : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
              }`}
            >
              {isSaving ? (
                <span>Saving...</span>
              ) : hasUnsavedChanges ? (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Synced</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 1-Click SRT Word Grouping Bar: Full Line | 1 Word | 2 Words | 3 Words | 4 Words */}
        <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-slate-950 border border-slate-800 rounded-lg">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
            <TypeIcon className="w-3.5 h-3.5 text-amber-400" />
            <span>SRT Words Per Subtitle:</span>
          </div>
          <div className="flex items-center gap-1">
            {(
              [
                { value: 0, label: 'Full Line' },
                { value: 1, label: '1 Word' },
                { value: 2, label: '2 Words' },
                { value: 3, label: '3 Words' },
                { value: 4, label: '4 Words' },
              ] as { value: WordsPerSegmentOption; label: string }[]
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleSelectWordGrouping(opt.value)}
                className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 ${
                  wordsMode === opt.value
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Automatic Speaker Detection & Rename Drawer */}
        {showSpeakerManager && (
          <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                Automatic Speaker Detection
              </span>
              <span className="text-[11px] text-slate-400">
                Identify who is speaking and keep conversations organized.
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {distinctSpeakers.map((spk) => (
                <div
                  key={spk}
                  className="flex items-center gap-2 px-2.5 py-1.5 bg-[#111827] border border-slate-800 rounded-md text-xs"
                >
                  {editingSpeaker === spk ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newSpeakerName}
                        onChange={(e) => setNewSpeakerName(e.target.value)}
                        placeholder={spk}
                        className="w-28 px-2 py-0.5 bg-slate-950 border border-amber-400 rounded text-xs text-slate-100"
                      />
                      <button
                        type="button"
                        onClick={() => commitSpeakerRename(spk)}
                        className="px-2 py-0.5 bg-amber-400 text-slate-950 font-semibold rounded text-[11px]"
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="font-medium text-slate-200">{spk}</span>
                      <span className="text-slate-600">→</span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSpeaker(spk);
                          setNewSpeakerName(spk);
                        }}
                        className="flex items-center gap-1 text-amber-400 hover:underline text-[11px]"
                      >
                        <Edit3 className="w-3 h-3" />
                        <span>Rename</span>
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timing Offset Drawer */}
        {showShiftBar && (
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-slate-950 border border-slate-800 rounded-lg">
            <span className="text-xs text-slate-300">
              Offset all subtitle timestamps (seconds):
            </span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="60"
                value={shiftOffset}
                onChange={(e) => setShiftOffset(e.target.value)}
                className="w-16 px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-800 rounded text-slate-100 tabular-nums text-center"
              />
              <button
                type="button"
                onClick={() => applyTimeShift(-1)}
                className="px-2.5 py-1 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded whitespace-nowrap shrink-0"
              >
                -{shiftOffset}s
              </button>
              <button
                type="button"
                onClick={() => applyTimeShift(1)}
                className="px-2.5 py-1 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded whitespace-nowrap shrink-0"
              >
                +{shiftOffset}s
              </button>
            </div>
          </div>
        )}

        {/* Search Transcript Input + Filter Tabs */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search words, speakers or phrases..."
                className="w-full pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-amber-400"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'km', label: 'Khmer' },
                  { id: 'en', label: 'English' },
                  { id: 'mixed', label: 'Mixed' },
                  { id: 'edited', label: 'Edited' },
                ] as { id: FilterMode; label: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterMode(tab.id)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    filterMode === tab.id
                      ? 'bg-slate-800 text-amber-400'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Search Results Jump Summary */}
          {searchQuery.trim() && (
            <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
              <div className="text-[11px] font-mono text-amber-400 tabular-nums">
                {filteredSegments.length} {filteredSegments.length === 1 ? 'result' : 'results'} found
              </div>
              <div className="flex flex-wrap gap-1.5">
                {filteredSegments.slice(0, 6).map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => onSeek(hit.start)}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-[#111827] hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors max-w-[220px] truncate"
                  >
                    <Play className="w-2.5 h-2.5 text-amber-400 fill-current shrink-0" />
                    <span className="font-mono text-amber-400 tabular-nums">
                      {formatTimestampShort(hit.start)}
                    </span>
                    <span className="text-slate-500">—</span>
                    <span className="truncate">{hit.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Segment Rows Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2.5 max-h-[580px]">
        {filteredSegments.length === 0 ? (
          <div className="py-12 text-center space-y-3">
            <p className="text-sm text-slate-400">
              {segments.length === 0
                ? 'No subtitle segments in this project yet.'
                : 'No segments match your current filter or search query.'}
            </p>
            <button
              type="button"
              onClick={() => onAddSegmentAtTime(currentTime)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-amber-400 text-slate-950 rounded-lg hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>+ Add Subtitle</span>
            </button>
          </div>
        ) : (
          filteredSegments.map((seg, i) => (
            <SubtitleRow
              key={seg.id}
              segment={seg}
              isActive={seg.id === activeSegmentId}
              isSelected={seg.id === selectedSegmentId}
              isLast={i === filteredSegments.length - 1}
              onSeek={onSeek}
              onSelect={onSelectSegment}
              onUpdate={onUpdateSegment}
              onRevert={onRevertSegment}
              onSplit={onSplitSegment}
              onDuplicate={onDuplicateSegment}
              onMergeWithNext={onMergeWithNext}
              onDelete={onDeleteSegment}
            />
          ))
        )}
      </div>
    </div>
  );
};
