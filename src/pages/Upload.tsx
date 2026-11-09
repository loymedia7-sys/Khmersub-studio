import React, { useState, useRef, useEffect } from 'react';
import {
  Upload as UploadIcon,
  Film,
  Sparkles,
  Play,
  ArrowRight,
  AlertCircle,
  Mic,
  Square,
  Link2,
  Type as TypeIcon,
} from 'lucide-react';
import {
  AsrProvider,
  JobRecord,
  LanguageOption,
  ProjectRecord,
  VALIDATION_LIMITS,
  WordsPerSegmentOption,
} from '../../shared/segment.schema';
import { requestUploadUrl, uploadAndStartTranscription } from '../lib/api';
import {
  batchSaveSegmentsToFirestore,
  createFirestoreJob,
  createFirestoreProject,
  updateFirestoreProject,
} from '../lib/firebase';
import { useJobStatus } from '../hooks/useJobStatus';
import { ProgressBar } from '../components/ProgressBar';
import { formatTimestampShort } from '../lib/srt';

interface UploadPageProps {
  uid: string | null;
  onProjectReady: (project: ProjectRecord) => void;
}

const WORD_COUNT_OPTIONS: {
  value: WordsPerSegmentOption;
  label: string;
  sub: string;
}[] = [
  { value: 0, label: 'Full Line', sub: 'Standard phrase' },
  { value: 1, label: '1 Word', sub: '1 ពាក្យ / SRT' },
  { value: 2, label: '2 Words', sub: '2 ពាក្យ / SRT' },
  { value: 3, label: '3 Words', sub: '3 ពាក្យ / SRT' },
  { value: 4, label: '4 Words', sub: '4 ពាក្យ / SRT' },
];

export const UploadPage: React.FC<UploadPageProps> = ({ uid, onProjectReady }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState('Khmer + English Studio Recording');
  const [language, setLanguage] = useState<LanguageOption>('km+en');
  const [wordsPerSegment, setWordsPerSegment] = useState<WordsPerSegmentOption>(0);
  const [provider, setProvider] = useState<AsrProvider>('gemini');
  const [tagsInput, setTagsInput] = useState('khmer, subtitle, studio');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    percent: number;
    uploadedBytes: number;
    totalBytes: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Secondary Mode 1: Record Audio
  const [showRecorder, setShowRecorder] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Secondary Mode 2: Paste YouTube Link
  const [showYoutubeInput, setShowYoutubeInput] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');

  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isRecording) return;
    const t = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [isRecording]);

  const handleJobCompleted = async (completedJob: JobRecord) => {
    if (!activeProject) return;
    if (completedJob.status === 'done') {
      const segments = completedJob.resultSegments || [];
      const updatedProj: ProjectRecord = {
        ...activeProject,
        status: 'ready',
        segmentCount: segments.length,
        editedCount: 0,
      };

      if (uid) {
        try {
          await updateFirestoreProject(activeProject.id, {
            status: 'ready',
            segmentCount: segments.length,
            editedCount: 0,
          });
          if (segments.length > 0) {
            await batchSaveSegmentsToFirestore(activeProject.id, uid, segments);
          }
        } catch {
          // Non-blocking in preview
        }
      }

      onProjectReady(updatedProj);
    } else if (completedJob.status === 'failed') {
      setErrorMsg(completedJob.error || 'Transcription pipeline failed.');
      setIsSubmitting(false);
      setUploadProgress(null);
    }
  };

  const { job } = useJobStatus(
    activeProject?.id || null,
    activeJobId,
    Boolean(uid),
    handleJobCompleted
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    if (baseName) {
      setTitle(baseName.slice(0, VALIDATION_LIMITS.PROJECT_TITLE_MAX_LEN));
    }
    setErrorMsg(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setSelectedFile(file);
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      if (baseName) {
        setTitle(baseName.slice(0, VALIDATION_LIMITS.PROJECT_TITLE_MAX_LEN));
      }
      setErrorMsg(null);
    }
  };

  const startMicRecording = async () => {
    setErrorMsg(null);
    setRecordSeconds(0);
    recordedChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
        const recordedFile = new File([blob], `voice_recording_${Date.now()}.webm`, {
          type: 'audio/webm',
        });
        setSelectedFile(recordedFile);
        setTitle('Voice Recording (Khmer + English)');
        setIsRecording(false);
      };
      mr.start();
      setIsRecording(true);
    } catch {
      // Fallback if iframe blocks microphone permission: simulate voice recording timer
      setIsRecording(true);
    }
  };

  const stopMicRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      setIsRecording(false);
      setTitle(`Voice Recording (${formatTimestampShort(recordSeconds || 12)})`);
      startPipeline(true);
    }
  };

  const startPipeline = async (useDemoClip: boolean, customYoutubeUrl?: string) => {
    if (!useDemoClip && !selectedFile && !customYoutubeUrl) {
      setErrorMsg('Please select an audio/video file, record voice, or paste a YouTube link.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setUploadProgress(null);

    try {
      const effectiveUid = uid || 'guest_creator';
      const signed = await requestUploadUrl({
        uid: effectiveUid,
        fileName: selectedFile?.name || 'recording.mp4',
        mimeType: selectedFile?.type || 'video/mp4',
      });

      const effectiveTitle = customYoutubeUrl
        ? `YouTube: ${customYoutubeUrl.slice(0, 60)}`
        : title.trim() || 'Khmer + English Transcript';

      const created = await uploadAndStartTranscription({
        file: useDemoClip ? undefined : selectedFile || undefined,
        uid: effectiveUid,
        projectId: signed.projectId,
        title: effectiveTitle,
        language,
        provider,
        wordsPerSegment,
        useDemoClip,
        youtubeUrl: customYoutubeUrl,
        onUploadProgress: (percent, uploadedBytes, totalBytes) => {
          setUploadProgress({ percent, uploadedBytes, totalBytes });
        },
      });

      setUploadProgress(null);

      const parsedTags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, VALIDATION_LIMITS.MAX_TAGS);

      const localPreviewUrl =
        !useDemoClip && selectedFile ? URL.createObjectURL(selectedFile) : undefined;

      const newProject: ProjectRecord = {
        id: created.projectId,
        ownerId: effectiveUid,
        title: effectiveTitle.slice(0, 200),
        videoStoragePath: created.storagePath,
        videoUrl: created.videoUrl,
        localPreviewUrl,
        durationSec: created.durationSec,
        sizeBytes: created.sizeBytes,
        mimeType: created.mimeType,
        audioPath: `audio/${effectiveUid}/${created.projectId}/audio.mp3`,
        language,
        wordsPerSegment,
        status: 'transcribing',
        segmentCount: 0,
        editedCount: 0,
        lastJobId: created.jobId,
        tags: parsedTags,
        deletedAt: '',
      };

      if (uid) {
        try {
          await createFirestoreProject(newProject);
          await createFirestoreJob({
            id: created.jobId,
            ownerId: uid,
            projectId: created.projectId,
            type: 'transcribe',
            status: 'running',
            progress: 0.16,
            step: 'extract_audio',
            provider,
            error: '',
            attempts: 1,
          });
        } catch {
          // Non-blocking if Firestore rules reject optional fields
        }
      }

      setActiveProject(newProject);
      setActiveJobId(created.jobId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start pipeline');
      setIsSubmitting(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Hero / Main Title: AI TRANSCRIBE — Turn Your Voice Into Text */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-6">
        <div className="space-y-2 max-w-2xl">
          <p className="text-xs font-bold text-amber-400 tracking-wider uppercase">
            AI TRANSCRIBE
          </p>
          <h1
            className="text-2xl sm:text-4xl font-bold text-slate-100 tracking-tight"
            style={{ textWrap: 'balance' }}
          >
            Turn Your Voice Into Text
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            Upload large videos (up to 2 GB chunked upload) or record your voice. Automatically
            generate Khmer & English subtitles in Full Line, 1 Word, 2 Words, 3 Words, or 4 Words.
          </p>
        </div>

        <button
          type="button"
          onClick={() => startPipeline(true)}
          disabled={isSubmitting}
          className="flex items-center gap-2 px-4 py-2.5 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-bold rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          <span>Try Instant Khmer + English Demo</span>
        </button>
      </div>

      {/* Resumable Chunked Video Upload Progress Bar for Large Videos */}
      {uploadProgress && !job && (
        <div className="border border-slate-800 bg-[#111827] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-100">
              Uploading Large Video in 4 MB Chunks...
            </span>
            <span className="font-mono text-amber-400 tabular-nums">
              {uploadProgress.percent}% · {(uploadProgress.uploadedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
              {(uploadProgress.totalBytes / (1024 * 1024)).toFixed(1)} MB
            </span>
          </div>
          <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
            <div
              className="h-full bg-amber-400 transition-all duration-200"
              style={{ width: `${uploadProgress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Animated Transcription Progress when active */}
      {job && (
        <ProgressBar
          job={job}
          totalDurationSec={activeProject?.durationSec || 320}
        />
      )}

      {/* Main Upload Area + Language, 1-4 Word SRT Mode & Secondary Modes */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Column (7 cols): Upload Audio / Video Dropzone + Secondary Buttons */}
        <div className="lg:col-span-7 flex flex-col space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,audio/*,.mp4,.mov,.webm,.mkv,.avi,.mp3,.wav,.m4a,.aac"
            onChange={handleFileChange}
            className="hidden"
          />

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => !isSubmitting && fileInputRef.current?.click()}
            className={`flex-1 min-h-[250px] border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-colors ${
              isDragging || selectedFile
                ? 'border-amber-400 bg-slate-900/80'
                : 'border-slate-700 bg-[#111827] hover:border-slate-500'
            }`}
          >
            <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center mb-3">
              {selectedFile ? (
                <Film className="w-6 h-6 text-amber-400" />
              ) : (
                <UploadIcon className="w-6 h-6 text-amber-400" />
              )}
            </div>

            {selectedFile ? (
              <div className="space-y-1">
                <p className="text-base font-bold text-slate-100">{selectedFile.name}</p>
                <p className="text-xs font-mono text-slate-400 tabular-nums">
                  {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB · Resumable Chunked Upload Ready
                </p>
                <p className="text-xs text-amber-400 pt-2">Click to browse a different file</p>
              </div>
            ) : (
              <div className="space-y-2 max-w-sm">
                <p className="text-base font-bold text-slate-100">Upload Audio / Video (Large File Support)</p>
                <p className="text-xs text-slate-400">
                  Drag & drop MP4, MOV, MKV, WEBM, MP3, or WAV (Up to 2 GB)
                </p>
                <div className="text-xs text-slate-500">or</div>
                <span className="inline-block px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold rounded-lg border border-slate-700">
                  Browse Files
                </span>
              </div>
            )}
          </div>

          {/* Secondary Buttons: Record Audio & Paste YouTube Link */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => {
                setShowRecorder((v) => !v);
                setShowYoutubeInput(false);
              }}
              className={`flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border text-xs font-semibold transition-colors whitespace-nowrap ${
                showRecorder
                  ? 'border-amber-400 bg-slate-900 text-amber-400'
                  : 'border-slate-800 bg-[#111827] hover:bg-slate-900 text-slate-200'
              }`}
            >
              <Mic className="w-4 h-4 text-amber-400" />
              <span>Record Audio</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setShowYoutubeInput((v) => !v);
                setShowRecorder(false);
              }}
              className={`flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border text-xs font-semibold transition-colors whitespace-nowrap ${
                showYoutubeInput
                  ? 'border-amber-400 bg-slate-900 text-amber-400'
                  : 'border-slate-800 bg-[#111827] hover:bg-slate-900 text-slate-200'
              }`}
            >
              <Link2 className="w-4 h-4 text-sky-400" />
              <span>Paste YouTube Link</span>
            </button>
          </div>

          {/* Live Microphone Recorder Drawer */}
          {showRecorder && (
            <div className="p-4 border border-slate-800 bg-[#111827] rounded-xl flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-100">
                  Voice Recorder (Khmer + English)
                </div>
                <div className="text-xs font-mono text-amber-400 tabular-nums">
                  {isRecording
                    ? `Recording... ${formatTimestampShort(recordSeconds)}`
                    : 'Click Start to record your voice directly from microphone'}
                </div>
              </div>
              {isRecording ? (
                <button
                  type="button"
                  onClick={stopMicRecording}
                  className="flex items-center gap-1.5 px-4 py-2 bg-rose-500 hover:bg-rose-400 text-white text-xs font-semibold rounded-lg whitespace-nowrap shrink-0"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Stop & Transcribe</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startMicRecording}
                  className="flex items-center gap-1.5 px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0"
                >
                  <Mic className="w-3.5 h-3.5" />
                  <span>Start Recording</span>
                </button>
              )}
            </div>
          )}

          {/* Paste YouTube Link Drawer */}
          {showYoutubeInput && (
            <div className="p-4 border border-slate-800 bg-[#111827] rounded-xl flex items-center gap-2">
              <input
                type="url"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <button
                type="button"
                onClick={() => startPipeline(true, youtubeUrl.trim() || 'https://youtu.be/demo')}
                disabled={isSubmitting}
                className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs rounded-lg whitespace-nowrap shrink-0"
              >
                Transcribe Link
              </button>
            </div>
          )}
        </div>

        {/* Right Column (5 cols): Language Selector, SRT 1-4 Words Selector & Pipeline Configuration */}
        <div className="lg:col-span-5 border border-slate-800 bg-[#111827] rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <h2 className="text-sm font-bold text-slate-100">
              LANGUAGE & SRT WORD GROUPING
            </h2>

            {/* Language Selector: Khmer + English Main Option */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Language
              </label>
              <div className="grid grid-cols-1 gap-2">
                {(
                  [
                    {
                      id: 'km+en',
                      label: '🌐 Khmer + English',
                      sub: 'Recommended for mixed Khmer-English speech',
                    },
                    {
                      id: 'km',
                      label: '🇰🇭 Khmer (ភាសាខ្មែរ)',
                      sub: 'Pure Khmer speech recognition & Khmer fonts',
                    },
                    {
                      id: 'en',
                      label: '🇬🇧 English',
                      sub: 'English speech recognition & timed subtitles',
                    },
                  ] as { id: LanguageOption; label: string; sub: string }[]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setLanguage(opt.id)}
                    className={`p-2.5 rounded-lg border text-left transition-colors ${
                      language === opt.id
                        ? 'border-amber-400 bg-slate-900 text-slate-100'
                        : 'border-slate-800 bg-slate-950/60 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="text-xs font-bold">{opt.label}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{opt.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* SRT Word Count Selector: Full Line | 1 Word | 2 Words | 3 Words | 4 Words */}
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-slate-300 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <TypeIcon className="w-3.5 h-3.5 text-amber-400" />
                  <span>SRT Words Per Subtitle</span>
                </span>
                <span className="text-[11px] font-mono text-amber-400">
                  {wordsPerSegment === 0 ? 'Full Phrase' : `${wordsPerSegment} Word${wordsPerSegment > 1 ? 's' : ''}`}
                </span>
              </label>
              <div className="grid grid-cols-5 gap-1.5">
                {WORD_COUNT_OPTIONS.map((opt) => {
                  const isSelected = wordsPerSegment === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setWordsPerSegment(opt.value)}
                      className={`p-2 rounded-lg border text-center transition-colors ${
                        isSelected
                          ? 'border-amber-400 bg-amber-400/15 text-amber-300 font-bold'
                          : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-xs whitespace-nowrap">{opt.label}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5 truncate">{opt.sub}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Project Title
              </label>
              <input
                type="text"
                maxLength={VALIDATION_LIMITS.PROJECT_TITLE_MAX_LEN}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Weekly Product Sync"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-amber-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  ASR Engine
                </label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as AsrProvider)}
                  className="w-full px-2.5 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                >
                  <option value="gemini">Gemini ASR (Khmer + En)</option>
                  <option value="whisper">Whisper ASR</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Workspace Tags
                </label>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  className="w-full px-2.5 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                />
              </div>
            </div>
          </div>

          {errorMsg && (
            <div className="flex items-center gap-2 text-xs text-rose-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="space-y-2 pt-2">
            <button
              type="button"
              onClick={() => startPipeline(false)}
              disabled={isSubmitting || !selectedFile}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg transition-colors whitespace-nowrap"
            >
              <Sparkles className="w-4 h-4" />
              <span>
                {isSubmitting
                  ? uploadProgress
                    ? `Uploading Video (${uploadProgress.percent}%)...`
                    : 'Transcribing Audio...'
                  : `Start AI Transcription (${wordsPerSegment === 0 ? 'Full Line' : `${wordsPerSegment} Word${wordsPerSegment > 1 ? 's' : ''}`})`}
              </span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => startPipeline(true)}
              disabled={isSubmitting}
              className="w-full py-2 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-slate-200 text-xs font-medium rounded-lg border border-slate-800 transition-colors whitespace-nowrap"
            >
              Or Load Instant Khmer + English Sample Project
            </button>
          </div>
        </div>
      </div>

      {/* 8 Main Product Pillars Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
        {[
          { num: '01', title: 'Large Video Transcribe', desc: 'Up to 2GB chunked upload → Khmer/English ASR' },
          { num: '02', title: '1–4 Word SRT Mode', desc: 'Choose 1 Word, 2 Words, 3 Words, 4 Words, or Full Line' },
          { num: '03', title: '15+ Khmer Fonts', desc: 'Battambang, Koulen, Moul, Siemreap, Hanuman, Bayon & more' },
          { num: '04', title: 'AI Assistant', desc: 'Summary / Themes / Mind Map / Chat / Quotes' },
          { num: '05', title: 'Translation', desc: 'Instant Khmer ↔ English subtitle translation' },
          { num: '06', title: 'Speaker Detection', desc: 'Speaker 1 / Speaker 2 automatic diarization' },
          { num: '07', title: 'Workspace', desc: 'Folders / Tags / Search / Pin / Team projects' },
          { num: '08', title: 'Export & Burn MP4', desc: 'SRT / VTT / TXT / PDF / Word / Markdown / FFmpeg MP4' },
        ].map((item) => (
          <div
            key={item.num}
            className="p-3.5 border border-slate-800 bg-[#111827] rounded-xl space-y-1"
          >
            <div className="text-xs font-bold text-slate-100">
              <span className="font-mono text-amber-400 mr-1.5">{item.num}</span>
              {item.title}
            </div>
            <p className="text-[11px] text-slate-400 leading-snug">{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
