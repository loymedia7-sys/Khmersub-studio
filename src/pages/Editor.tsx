import React, { useState, useMemo } from 'react';
import {
  Folder,
  Mic,
  Film,
  Clock,
  Scissors,
  Merge,
  Plus,
  Copy,
  Trash2,
  Edit3,
  Palette,
  Download,
} from 'lucide-react';
import {
  AiAnalysisResult,
  BUILT_IN_TEMPLATES,
  CaptionTemplate,
  ProjectRecord,
  WordsPerSegmentOption,
} from '../../shared/segment.schema';
import { useProject } from '../hooks/useProject';
import { VideoPlayer } from '../components/VideoPlayer';
import { SubtitleList } from '../components/SubtitleList';
import { Timeline } from '../components/Timeline';
import { ExportPanel } from '../components/ExportPanel';
import { StyleEditorPanel } from '../components/StyleEditorPanel';
import { AiWorkspacePanel } from '../components/AiWorkspacePanel';
import { formatTimestampDisplay, regroupSegmentsByWordCount } from '../lib/srt';

interface EditorPageProps {
  project: ProjectRecord;
  allProjects: ProjectRecord[];
  uid: string | null;
  customTemplates: CaptionTemplate[];
  initialRightTab?: RightWorkspaceTab;
  onSelectProject: (proj: ProjectRecord) => void;
  onNavigateUpload: () => void;
}

export type LeftSidebarFilter = 'projects' | 'audio' | 'videos' | 'recent';
export type SubtitleCenterTab = 'edit' | 'timeline' | 'style' | 'animate' | 'export';
export type RightWorkspaceTab =
  | 'transcript'
  | 'summary'
  | 'themes'
  | 'mindmap'
  | 'chat'
  | 'subtitles';

export const EditorPage: React.FC<EditorPageProps> = ({
  project,
  allProjects,
  uid,
  customTemplates,
  initialRightTab = 'transcript',
  onSelectProject,
  onNavigateUpload,
}) => {
  const {
    segments,
    exportsList,
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
  } = useProject(project, uid);

  const [leftFilter, setLeftFilter] = useState<LeftSidebarFilter>('projects');
  const [centerTab, setCenterTab] = useState<SubtitleCenterTab>('animate');
  const [rightTab, setRightTab] = useState<RightWorkspaceTab>(initialRightTab);

  const [currentTime, setCurrentTime] = useState(0);
  const [durationSec, setDurationSec] = useState(project.durationSec || 18);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [seekTrigger, setSeekTrigger] = useState<{ time: number; seq: number } | null>(null);
  const [analysis, setAnalysis] = useState<AiAnalysisResult | null>(null);
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [videoVisible, setVideoVisible] = useState(true);

  const [activeTemplate, setActiveTemplate] = useState<CaptionTemplate>({
    ...BUILT_IN_TEMPLATES[0],
    entranceAnimation: 'pop',
    exitAnimation: 'none',
    loopAnimation: 'none',
    animationDuration: 0.4,
    outAnimationDuration: 0.3,
    loopAnimationDuration: 1.2,
    animationEasing: 'overshoot',
    animateBy: 'word',
    aspectRatio: 'original',
    scaleMode: 'fit',
    ownerId: 'system',
  });

  // Identify currently playing segment
  const activeSegment = useMemo(() => {
    return (
      segments.find((seg) => currentTime >= seg.start && currentTime <= seg.end) || null
    );
  }, [segments, currentTime]);

  // Selected subtitle in inspector (falls back to activeSegment or first segment)
  const inspectedSegment = useMemo(() => {
    if (selectedSegmentId) {
      const found = segments.find((s) => s.id === selectedSegmentId);
      if (found) return found;
    }
    return activeSegment || segments[0] || null;
  }, [segments, selectedSegmentId, activeSegment]);

  const handleSeek = (targetTime: number) => {
    setSeekTrigger((prev) => ({ time: targetTime, seq: (prev?.seq || 0) + 1 }));
  };

  const handleUpdateTemplate = (patch: Partial<CaptionTemplate>) => {
    setActiveTemplate((prev) => ({ ...prev, ...patch }));
  };

  const handleUpdateSegmentTiming = (segId: string, start: number, end: number) => {
    updateSegment(segId, { start, end });
  };

  const handleRegroupWords = (wordsPerSeg: WordsPerSegmentOption) => {
    if (segments.length === 0) return;
    if (wordsPerSeg > 0) {
      replaceAllSegments(regroupSegmentsByWordCount(segments, wordsPerSeg));
    }
  };

  const handleReplayPreview = () => {
    const targetSeg = inspectedSegment || segments[0];
    if (targetSeg) {
      handleSeek(targetSeg.start);
    }
  };

  return (
    <div className="max-w-[1440px] mx-auto space-y-4">
      {/* FULL 3-COLUMN STUDIO STRUCTURE: MY FILES | VIDEO PREVIEW + SUBTITLE EDITOR | TRANSCRIPT & AI */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN (2 cols): MY FILES (Projects / Audio / Videos / Recent) */}
        <aside className="lg:col-span-2 border border-slate-800 bg-[#111827] rounded-xl p-3.5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-300 tracking-wider uppercase">
              MY FILES
            </span>
            <button
              type="button"
              onClick={onNavigateUpload}
              className="px-2 py-1 text-[11px] font-semibold bg-amber-400 hover:bg-amber-300 text-slate-950 rounded transition-colors whitespace-nowrap"
            >
              + New
            </button>
          </div>

          <div className="space-y-1">
            {(
              [
                { id: 'projects', label: 'Projects', icon: Folder },
                { id: 'audio', label: 'Audio', icon: Mic },
                { id: 'videos', label: 'Videos', icon: Film },
                { id: 'recent', label: 'Recent', icon: Clock },
              ] as { id: LeftSidebarFilter; label: string; icon: React.ElementType }[]
            ).map((item) => {
              const Icon = item.icon;
              const isAct = leftFilter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setLeftFilter(item.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    isAct
                      ? 'bg-slate-800 text-amber-400'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-slate-800 space-y-1.5">
            <div className="text-[11px] font-medium text-slate-500">
              Active Workspace ({allProjects.length})
            </div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {allProjects.map((p) => {
                const isCurrent = p.id === project.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelectProject(p)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors truncate ${
                      isCurrent
                        ? 'bg-amber-400/15 border border-amber-400/50 text-amber-300 font-semibold'
                        : 'text-slate-300 hover:bg-slate-900'
                    }`}
                  >
                    <div className="truncate">{p.title}</div>
                    <div className="text-[10px] font-mono text-slate-500 tabular-nums mt-0.5">
                      {p.language.toUpperCase()} · {p.segmentCount} lines
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* CENTER COLUMN (5 cols): SUBTITLE EDITOR (EDIT | TIMELINE | STYLE | ANIMATE | EXPORT) + VIDEO PREVIEW */}
        <section className="lg:col-span-5 space-y-4">
          {/* Subtitle Editor Header + 5 Mode Tabs */}
          <div className="border border-slate-800 bg-[#111827] rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h1 className="text-sm font-bold text-slate-100">SUBTITLE EDITOR</h1>
                <p className="text-xs text-slate-400">
                  Create accurate, perfectly timed subtitles from your transcript.
                </p>
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                {(
                  [
                    { id: 'edit', label: 'EDIT' },
                    { id: 'timeline', label: 'TIMELINE' },
                    { id: 'style', label: 'STYLE' },
                    { id: 'animate', label: 'ANIMATE' },
                    { id: 'export', label: 'EXPORT' },
                  ] as { id: SubtitleCenterTab; label: string }[]
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setCenterTab(tab.id)}
                    className={`px-2.5 py-1 text-xs font-bold rounded transition-colors whitespace-nowrap shrink-0 ${
                      centerTab === tab.id
                        ? 'bg-amber-400 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Synchronized Video Player & Aspect Ratio Monitor */}
          <VideoPlayer
            videoUrl={project.localPreviewUrl || project.videoUrl}
            durationSec={durationSec}
            currentTime={currentTime}
            segments={segments}
            activeSegment={activeSegment}
            template={activeTemplate}
            captionsVisible={captionsVisible}
            videoVisible={videoVisible}
            onUpdateTemplate={handleUpdateTemplate}
            onTimeUpdate={setCurrentTime}
            onDurationLoaded={setDurationSec}
            onAddSegmentAtCurrentTime={addSegmentAtTime}
            onSelectSegment={(id, time) => {
              setSelectedSegmentId(id);
              handleSeek(time);
            }}
            seekTrigger={seekTrigger}
          />

          {/* Center Contextual Panel based on EDIT | TIMELINE | STYLE | ANIMATE | EXPORT */}
          {(centerTab === 'edit' || centerTab === 'timeline') && inspectedSegment && (
            <div className="border border-slate-800 bg-[#111827] rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-200">
                  SUBTITLE TEXT EDITOR · Selected Subtitle
                </span>
                <span className="font-mono text-xs text-amber-400 tabular-nums">
                  {formatTimestampDisplay(inspectedSegment.start)} →{' '}
                  {formatTimestampDisplay(inspectedSegment.end)}
                </span>
              </div>

              <textarea
                rows={2}
                value={inspectedSegment.text}
                onChange={(e) =>
                  updateSegment(inspectedSegment.id, { text: e.target.value })
                }
                style={{
                  fontFamily: '"Battambang", "Noto Sans Khmer", "Plus Jakarta Sans", sans-serif',
                }}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-amber-400 resize-none"
              />

              {/* Action Buttons: Split at Current Time, Merge, Delete, Add Subtitle, Duplicate */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => splitSegment(inspectedSegment.id, currentTime)}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <Scissors className="w-3.5 h-3.5 text-amber-400" />
                  <span>Split at Current Time</span>
                </button>

                <button
                  type="button"
                  onClick={() => mergeWithNext(inspectedSegment.id)}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <Merge className="w-3.5 h-3.5 text-sky-400" />
                  <span>Merge</span>
                </button>

                <button
                  type="button"
                  onClick={() => addSegmentAtTime(currentTime)}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5 text-emerald-400" />
                  <span>+ Add Subtitle</span>
                </button>

                <button
                  type="button"
                  onClick={() => duplicateSegment(inspectedSegment.id)}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <Copy className="w-3.5 h-3.5 text-slate-300" />
                  <span>Duplicate</span>
                </button>

                <button
                  type="button"
                  onClick={() => deleteSegment(inspectedSegment.id)}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-900 hover:bg-rose-950/60 border border-slate-800 rounded-lg text-xs font-medium text-rose-400 transition-colors whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete</span>
                </button>
              </div>
            </div>
          )}

          {(centerTab === 'style' || centerTab === 'animate' || centerTab === 'timeline') && (
            <StyleEditorPanel
              key={centerTab}
              uid={uid}
              activeTemplate={activeTemplate}
              customTemplates={customTemplates}
              onSelectTemplate={setActiveTemplate}
              onUpdateTemplate={handleUpdateTemplate}
              initialSubTab={
                centerTab === 'animate'
                  ? 'animate'
                  : centerTab === 'timeline'
                    ? 'timing'
                    : 'style'
              }
              inspectedSegment={inspectedSegment}
              onShiftAllTimings={shiftAllTimings}
              onUpdateSegmentTiming={handleUpdateSegmentTiming}
              onRegroupWords={handleRegroupWords}
              onReplayPreview={handleReplayPreview}
            />
          )}

          {centerTab === 'export' && (
            <ExportPanel
              projectId={project.id}
              projectTitle={project.title}
              uid={uid}
              segments={segments}
              exportsList={exportsList}
              activeTemplate={activeTemplate}
              analysis={analysis}
            />
          )}
        </section>

        {/* RIGHT COLUMN (5 cols): Top Navigation (Transcript | Summary | Themes | Mind Map | Chat | Subtitles) */}
        <section className="lg:col-span-5 space-y-3">
          {/* Top Navigation Bar for Transcript & AI Workspace */}
          <div className="flex flex-wrap items-center gap-1 p-1.5 bg-[#111827] border border-slate-800 rounded-xl">
            {(
              [
                { id: 'transcript', label: 'Transcript' },
                { id: 'summary', label: 'Summary' },
                { id: 'themes', label: 'Themes' },
                { id: 'mindmap', label: 'Mind Map' },
                { id: 'chat', label: 'Chat' },
                { id: 'subtitles', label: 'Subtitles' },
              ] as { id: RightWorkspaceTab; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setRightTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                  rightTab === tab.id
                    ? 'bg-amber-400 text-slate-950'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {rightTab === 'transcript' || rightTab === 'subtitles' ? (
            <SubtitleList
              projectId={project.id}
              ownerId={uid || project.ownerId}
              segments={segments}
              activeSegmentId={activeSegment?.id || null}
              selectedSegmentId={selectedSegmentId}
              currentTime={currentTime}
              isSaving={isSaving}
              hasUnsavedChanges={hasUnsavedChanges}
              lastSavedAt={lastSavedAt}
              onSeek={handleSeek}
              onSelectSegment={setSelectedSegmentId}
              onUpdateSegment={updateSegment}
              onRenameSpeaker={renameSpeakerAcrossSegments}
              onRevertSegment={revertSegment}
              onSplitSegment={(id) => splitSegment(id, currentTime)}
              onDuplicateSegment={duplicateSegment}
              onMergeWithNext={mergeWithNext}
              onDeleteSegment={deleteSegment}
              onAddSegmentAtTime={addSegmentAtTime}
              onShiftAllTimings={shiftAllTimings}
              onReplaceAllSegments={replaceAllSegments}
              onSaveAll={saveAllSegments}
            />
          ) : (
            <AiWorkspacePanel
              mode={rightTab}
              projectTitle={project.title}
              segments={segments}
              analysis={analysis}
              onAnalysisLoaded={setAnalysis}
              onSeek={handleSeek}
              onReplaceSegments={replaceAllSegments}
            />
          )}
        </section>
      </div>

      {/* FULL-WIDTH MULTI-TRACK STUDIO TIMELINE DOCK */}
      <Timeline
        segments={segments}
        durationSec={durationSec}
        currentTime={currentTime}
        videoUrl={project.localPreviewUrl || project.videoUrl}
        activeFont={activeTemplate.font}
        customFontName={activeTemplate.customFontName}
        templateName={activeTemplate.name}
        aspectRatio={activeTemplate.aspectRatio || 'original'}
        captionsVisible={captionsVisible}
        videoVisible={videoVisible}
        activeSegmentId={activeSegment?.id || null}
        selectedSegmentId={selectedSegmentId}
        onSeek={handleSeek}
        onSelectSegment={setSelectedSegmentId}
        onUpdateSegmentTiming={handleUpdateSegmentTiming}
        onAddSegmentAtCurrentTime={addSegmentAtTime}
        onSplitSegment={(id) => splitSegment(id, currentTime)}
        onMergeSegment={mergeWithNext}
        onDuplicateSegment={duplicateSegment}
        onDeleteSegment={deleteSegment}
        onRegroupWords={handleRegroupWords}
        onChangeAspectRatio={(r) => handleUpdateTemplate({ aspectRatio: r })}
        onToggleCaptionsVisible={() => setCaptionsVisible((v) => !v)}
        onToggleVideoVisible={() => setVideoVisible((v) => !v)}
      />

      {/* BOTTOM STUDIO ACTION DOCK: Edit | Style | Animate | Split | Merge | Add | Export */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border border-slate-800 bg-[#0F1522] rounded-xl">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCenterTab('edit')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              centerTab === 'edit'
                ? 'bg-amber-400 text-slate-950'
                : 'bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800'
            }`}
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Edit</span>
          </button>

          <button
            type="button"
            onClick={() => setCenterTab('style')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              centerTab === 'style'
                ? 'bg-amber-400 text-slate-950'
                : 'bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            <span>Style</span>
          </button>

          <button
            type="button"
            onClick={() => setCenterTab('animate')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              centerTab === 'animate'
                ? 'bg-[#2B1644] border border-[#9353D3] text-white'
                : 'bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800'
            }`}
          >
            <span>Animate</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (inspectedSegment) splitSegment(inspectedSegment.id, currentTime);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Scissors className="w-3.5 h-3.5 text-amber-400" />
            <span>Split</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (inspectedSegment) mergeWithNext(inspectedSegment.id);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Merge className="w-3.5 h-3.5 text-sky-400" />
            <span>Merge</span>
          </button>

          <button
            type="button"
            onClick={() => addSegmentAtTime(currentTime)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            <span>Add</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => setCenterTab('export')}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-amber-400 hover:bg-amber-300 text-slate-950 transition-colors whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export (SRT / VTT / Word / PDF / MP4)</span>
        </button>
      </div>
    </div>
  );
};
