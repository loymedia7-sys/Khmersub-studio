import React, { useState } from 'react';
import {
  FolderOpen,
  Plus,
  Search,
  Trash2,
  ArrowUpRight,
  Database,
  Pin,
} from 'lucide-react';
import { ProjectRecord, UserProfileRecord } from '../../shared/segment.schema';
import { formatTimestampDisplay } from '../lib/srt';

interface ProjectsPageProps {
  projects: ProjectRecord[];
  userProfile: UserProfileRecord | null;
  onSelectProject: (project: ProjectRecord) => void;
  onDeleteProject: (projectId: string) => Promise<void>;
  onNavigateUpload: () => void;
}

export const ProjectsPage: React.FC<ProjectsPageProps> = ({
  projects,
  userProfile,
  onSelectProject,
  onDeleteProject,
  onNavigateUpload,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ready' | 'pinned'>('all');
  const [pinnedIds, setPinnedIds] = useState<Record<string, boolean>>({});
  const [showSchemaDrawer, setShowSchemaDrawer] = useState(false);

  const togglePin = (id: string) => {
    setPinnedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const filtered = projects.filter((p) => {
    if (statusFilter === 'ready' && p.status !== 'ready') return false;
    if (statusFilter === 'pinned' && !pinnedIds[p.id]) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        p.title.toLowerCase().includes(q) ||
        p.language.toLowerCase().includes(q) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <p className="text-xs font-bold text-amber-400 tracking-wider uppercase mb-1">
            WORKSPACE · FOLDERS · TAGS · SEARCH
          </p>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">
            My Files & Projects
          </h1>
          <div className="flex items-center gap-2 text-xs text-slate-400 mt-1 font-mono tabular-nums">
            <span>{projects.length} projects</span>
            {userProfile && (
              <>
                <span aria-hidden="true">·</span>
                <span>Plan: {userProfile.plan.toUpperCase()}</span>
                <span aria-hidden="true">·</span>
                <span>
                  Credits: {(userProfile.minutesLimit - userProfile.minutesTranscribed).toFixed(1)} min remaining
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowSchemaDrawer((v) => !v)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Database className="w-3.5 h-3.5 text-amber-400" />
            <span>{showSchemaDrawer ? 'Hide Architecture' : 'Firestore Schema'}</span>
          </button>

          <button
            type="button"
            onClick={onNavigateUpload}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Transcribe</span>
          </button>
        </div>
      </div>

      {showSchemaDrawer && (
        <div className="border border-slate-800 bg-[#111827] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Firestore Subcollection & Storage Architecture
            </h2>
            <span className="text-xs font-mono text-slate-400 tabular-nums">
              1 MiB Doc Limit Safe · Batched Writes
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5 font-mono">
              <div className="text-amber-400 font-semibold">Firestore Collections</div>
              <div className="text-slate-300">users/&#123;uid&#125;</div>
              <div className="text-slate-300">projects/&#123;projectId&#125;</div>
              <div className="text-slate-400 pl-3">└── segments/&#123;segmentId&#125;</div>
              <div className="text-slate-400 pl-3">└── jobs/&#123;jobId&#125;</div>
              <div className="text-slate-400 pl-3">└── exports/&#123;exportId&#125;</div>
              <div className="text-slate-300">templates/&#123;templateId&#125;</div>
            </div>
            <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5 font-mono">
              <div className="text-amber-400 font-semibold">Media Storage Paths</div>
              <div className="text-slate-300">uploads/&#123;uid&#125;/&#123;projectId&#125;/video.mp4</div>
              <div className="text-slate-300">audio/&#123;uid&#125;/&#123;projectId&#125;/audio.wav</div>
              <div className="text-slate-300">exports/&#123;uid&#125;/&#123;projectId&#125;/subs.srt</div>
              <div className="text-slate-300">exports/&#123;uid&#125;/&#123;projectId&#125;/subs.vtt</div>
              <div className="text-slate-300">exports/&#123;uid&#125;/&#123;projectId&#125;/burned.mp4</div>
            </div>
            <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
              <div className="font-mono text-amber-400 font-semibold">Composite Indexes</div>
              <p className="text-slate-300 leading-relaxed">
                1. <span className="font-mono">projects</span>: ownerId ASC, deletedAt ASC, updatedAt DESC
              </p>
              <p className="text-slate-300 leading-relaxed">
                2. <span className="font-mono">segments</span>: projectId ASC, index ASC
              </p>
              <p className="text-slate-300 leading-relaxed">
                3. <span className="font-mono">jobs</span>: status ASC, startedAt ASC
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Search & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects, tags, or languages..."
            className="w-full pl-9 pr-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-amber-400"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-lg">
          {(
            [
              { id: 'all', label: 'All Files' },
              { id: 'ready', label: 'Ready' },
              { id: 'pinned', label: 'Pinned' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === tab.id
                  ? 'bg-slate-800 text-amber-400'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="border border-slate-800 bg-[#111827] rounded-xl p-12 text-center space-y-3">
          <FolderOpen className="w-8 h-8 text-slate-500 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-200">
            No Recordings or Subtitle Projects Found
          </h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Upload an audio/video file, record your voice, or try the instant Khmer + English demo clip.
          </p>
          <button
            type="button"
            onClick={onNavigateUpload}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-amber-400 text-slate-950 rounded-lg hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Start First Transcription</span>
          </button>
        </div>
      ) : (
        <div className="border border-slate-800 bg-[#111827] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0F1522] text-[11px] font-medium text-slate-400">
                  <th className="py-3 px-4">Project / Recording</th>
                  <th className="py-3 px-4">Language</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Duration</th>
                  <th className="py-3 px-4 text-right">Segments</th>
                  <th className="py-3 px-4 text-right">Edited</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-xs">
                {filtered.map((proj) => (
                  <tr
                    key={proj.id}
                    onClick={() => onSelectProject(proj)}
                    className="hover:bg-slate-900/70 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                        {pinnedIds[proj.id] && (
                          <Pin className="w-3 h-3 text-amber-400 fill-current shrink-0" />
                        )}
                        <span>{proj.title}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono truncate max-w-xs mt-0.5">
                        {proj.videoStoragePath}
                        {proj.tags && proj.tags.length > 0 && (
                          <>
                            <span className="mx-1.5">·</span>
                            <span>{proj.tags.join(', ')}</span>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono uppercase text-slate-300 tabular-nums">
                      {proj.language}
                    </td>
                    <td className="py-3 px-4 text-slate-300 capitalize">{proj.status}</td>
                    <td className="py-3 px-4 text-right font-mono text-slate-300 tabular-nums">
                      {formatTimestampDisplay(proj.durationSec)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-200 tabular-nums">
                      {proj.segmentCount}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-amber-400 tabular-nums">
                      {proj.editedCount}
                    </td>
                    <td
                      className="py-3 px-4 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => togglePin(proj.id)}
                          className={`p-1.5 rounded transition-colors ${
                            pinnedIds[proj.id]
                              ? 'text-amber-400 bg-slate-800'
                              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                          }`}
                          title="Pin project"
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectProject(proj)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded font-medium transition-colors whitespace-nowrap shrink-0"
                        >
                          <span>Open Studio</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteProject(proj.id)}
                          className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-900 rounded transition-colors"
                          title="Delete project"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
