import { useState, useEffect } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  auth,
  signInWithGoogle,
  signOutUser,
  ensureUserProfile,
  subscribeUserProjects,
  subscribeUserTemplates,
  softDeleteFirestoreProject,
} from './lib/firebase';
import {
  CaptionTemplate,
  ProjectRecord,
  UserProfileRecord,
} from '../shared/segment.schema';
import { deleteBackendProject } from './lib/api';
import { UploadPage } from './pages/Upload';
import { ProjectsPage } from './pages/Projects';
import { EditorPage, RightWorkspaceTab } from './pages/Editor';

type ActiveTab = 'upload' | 'projects' | 'editor';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfileRecord | null>(null);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [customTemplates, setCustomTemplates] = useState<CaptionTemplate[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('upload');
  const [editorRightTab, setEditorRightTab] = useState<RightWorkspaceTab>('transcript');
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currUser) => {
      setUser(currUser);
      setAuthReady(true);
      if (currUser) {
        try {
          const profile = await ensureUserProfile(currUser);
          setUserProfile(profile);
        } catch {
          // Non-blocking profile check
        }
      } else {
        setUserProfile(null);
        setProjects([]);
        setCustomTemplates([]);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;
    const unsubProjects = subscribeUserProjects(user.uid, (liveProjects) => {
      setProjects(liveProjects);
      if (activeProject) {
        const updated = liveProjects.find((p) => p.id === activeProject.id);
        if (updated) setActiveProject(updated);
      }
    });

    const unsubTemplates = subscribeUserTemplates(user.uid, (liveTemplates) => {
      setCustomTemplates(liveTemplates);
    });

    return () => {
      unsubProjects();
      unsubTemplates();
    };
  }, [authReady, user?.uid]);

  const handleAuthAction = async () => {
    setAuthError(null);
    try {
      if (user) {
        await signOutUser();
      } else {
        await signInWithGoogle();
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in failed');
    }
  };

  const handleProjectReady = (project: ProjectRecord) => {
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === project.id);
      return exists ? prev.map((p) => (p.id === project.id ? project : p)) : [project, ...prev];
    });
    setActiveProject(project);
    setEditorRightTab('transcript');
    setActiveTab('editor');
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await deleteBackendProject(projectId).catch(() => {});
    } catch {
      // non-blocking
    }
    if (user) {
      await softDeleteFirestoreProject(projectId);
    }
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (activeProject?.id === projectId) {
      setActiveProject(null);
      setActiveTab('projects');
    }
  };

  const openEditorWithRightTab = (tab: RightWorkspaceTab) => {
    setEditorRightTab(tab);
    if (activeProject) {
      setActiveTab('editor');
    } else if (projects.length > 0) {
      setActiveProject(projects[0]);
      setActiveTab('editor');
    } else {
      setActiveTab('upload');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0F17] text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-[#0F1522]">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#transcribe"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('upload');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          Khmersub Studio
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#transcribe"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('upload');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'upload' ? 'text-amber-400 underline underline-offset-8' : ''
            }`}
          >
            Transcribe
          </a>
          <a
            href="#editor"
            onClick={(e) => {
              e.preventDefault();
              openEditorWithRightTab('transcript');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'editor' && editorRightTab === 'transcript'
                ? 'text-amber-400 underline underline-offset-8'
                : ''
            }`}
          >
            Subtitle Editor
          </a>
          <a
            href="#ai-assistant"
            onClick={(e) => {
              e.preventDefault();
              openEditorWithRightTab('summary');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'editor' && editorRightTab !== 'transcript'
                ? 'text-amber-400 underline underline-offset-8'
                : ''
            }`}
          >
            AI Assistant
          </a>
          <a
            href="#workspace"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('projects');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'projects' ? 'text-amber-400 underline underline-offset-8' : ''
            }`}
          >
            Workspace ({projects.length})
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleAuthAction}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 rounded-lg hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
          >
            {user
              ? `Sign Out (${user.displayName || user.email?.split('@')[0]})`
              : 'Sign In with Google'}
          </button>
        </div>
      </header>

      {authError && (
        <div className="bg-rose-950/60 border-b border-rose-800 px-6 py-2 text-xs text-rose-200 flex items-center justify-between">
          <span>{authError}</span>
          <button
            type="button"
            onClick={() => setAuthError(null)}
            className="underline ml-4 whitespace-nowrap"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Content Viewport */}
      <main className="flex-1 px-4 sm:px-6 py-6">
        {activeTab === 'upload' && (
          <UploadPage
            uid={user?.uid || null}
            onProjectReady={handleProjectReady}
          />
        )}

        {activeTab === 'projects' && (
          <ProjectsPage
            projects={projects}
            userProfile={userProfile}
            onSelectProject={(proj) => {
              setActiveProject(proj);
              setActiveTab('editor');
            }}
            onDeleteProject={handleDeleteProject}
            onNavigateUpload={() => setActiveTab('upload')}
          />
        )}

        {activeTab === 'editor' && activeProject && (
          <EditorPage
            key={`${activeProject.id}_${editorRightTab}`}
            project={activeProject}
            allProjects={projects.length > 0 ? projects : [activeProject]}
            uid={user?.uid || null}
            customTemplates={customTemplates}
            initialRightTab={editorRightTab}
            onSelectProject={(proj) => setActiveProject(proj)}
            onNavigateUpload={() => setActiveTab('upload')}
          />
        )}

        {activeTab === 'editor' && !activeProject && (
          <UploadPage
            uid={user?.uid || null}
            onProjectReady={handleProjectReady}
          />
        )}
      </main>

      {/* Clean Minimal Footer */}
      <footer className="px-6 py-4 border-t border-slate-800/80 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-4">
        <div>
          Khmersub Studio · Khmer & English AI Transcribe & Subtitle Editor
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setActiveTab('upload')}
            className="hover:text-slate-300 transition-colors whitespace-nowrap"
          >
            AI Transcribe
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('projects')}
            className="hover:text-slate-300 transition-colors whitespace-nowrap"
          >
            Workspace
          </button>
        </div>
      </footer>
    </div>
  );
}
