import React, { useState } from 'react';
import {
  Download,
  Film,
  FileText,
  CheckCircle2,
  Loader2,
  FileCode,
  FileSpreadsheet,
  Type as TypeIcon,
  Sparkles,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import {
  AiAnalysisResult,
  CaptionTemplate,
  ExportFormat,
  ExportRecord,
  SubtitleSegment,
  WordsPerSegmentOption,
  resolveFontFamilyCss,
} from '../../shared/segment.schema';
import {
  buildMarkdown,
  buildSrt,
  buildTxt,
  buildVtt,
  buildWordDocHtml,
  regroupSegmentsByWordCount,
} from '../lib/srt';
import {
  downloadExportedFileChunked,
  startProjectExport,
  syncSegmentsToBackend,
} from '../lib/api';
import { createFirestoreExport } from '../lib/firebase';

interface ExportPanelProps {
  projectId: string;
  projectTitle: string;
  uid: string | null;
  segments: SubtitleSegment[];
  exportsList: ExportRecord[];
  activeTemplate: CaptionTemplate;
  analysis?: AiAnalysisResult | null;
}

const EXPORT_ANIMATION_STEPS = [
  'Preparing current subtitles...',
  'Generating accurate timestamps...',
  'Checking subtitle timing...',
  'Applying Khmer font formatting...',
  'Export complete ✓',
];

export const ExportPanel: React.FC<ExportPanelProps> = ({
  projectId,
  projectTitle,
  uid,
  segments,
  exportsList,
  activeTemplate,
  analysis,
}) => {
  const [exportWordsMode, setExportWordsMode] = useState<WordsPerSegmentOption>(0);
  const [animatingFormat, setAnimatingFormat] = useState<ExportFormat | null>(null);
  const [animStepIdx, setAnimStepIdx] = useState<number>(0);
  const [readyDownload, setReadyDownload] = useState<{
    format: ExportFormat;
    blobUrl: string;
    fileName: string;
  } | null>(null);

  const [isBurning, setIsBurning] = useState(false);
  const [burnProgressText, setBurnProgressText] = useState<string>('');
  const [burnError, setBurnError] = useState<string | null>(null);
  const [latestBurnUrl, setLatestBurnUrl] = useState<string | null>(null);
  const [latestBurnFileName, setLatestBurnFileName] = useState<string>('khmer_subtitled_video.mp4');
  const [directDownloadNotice, setDirectDownloadNotice] = useState<string | null>(null);
  const [downloadingItemId, setDownloadingItemId] = useState<string | null>(null);

  /**
   * Triggers a clean browser file download from an in-memory Blob URL
   * so Cloud Run / iframe proxy never intercepts the navigation with a cookie redirect file.
   */
  const triggerBlobUrlDownload = (blobUrl: string, fileName: string) => {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  /**
   * Instantly downloads the exact CURRENT studio result without re-chunking, re-splitting, or changing any text or timecodes
   */
  const handleDownloadCurrentResultDirect = async (
    format: 'srt' | 'vtt' | 'txt' | 'word' | 'markdown'
  ) => {
    if (segments.length === 0) return;
    const safeTitle = (projectTitle || projectId).replace(/[^a-zA-Z0-9_\-]/g, '_');
    let content = '';
    let mime = 'text/plain;charset=utf-8';
    let ext: string = format;

    if (format === 'srt') {
      content = buildSrt(segments, 0); // 0 = exact current result
    } else if (format === 'vtt') {
      content = buildVtt(segments, 0);
      mime = 'text/vtt;charset=utf-8';
    } else if (format === 'txt') {
      content = buildTxt(segments);
    } else if (format === 'markdown') {
      content = buildMarkdown(projectTitle, segments, analysis);
      mime = 'text/markdown;charset=utf-8';
      ext = 'md';
    } else if (format === 'word') {
      content = buildWordDocHtml(projectTitle, segments, analysis);
      mime = 'application/msword;charset=utf-8';
      ext = 'doc';
    }

    const blob = new Blob([content], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    const fileName = `${safeTitle}_current_result.${ext}`;

    triggerBlobUrlDownload(blobUrl, fileName);

    setDirectDownloadNotice(
      `Downloaded exact current result (${fileName}) with UTF-8 BOM & intact Khmer font.`
    );
    setTimeout(() => setDirectDownloadNotice(null), 4500);

    // Sync to backend non-blockingly so server matches
    syncSegmentsToBackend(projectId, segments).catch(() => {});
  };

  /**
   * Runs the Smean 5-step SRT / Document Export Animation before presenting the Download CTA
   */
  const runAnimatedExport = async (format: Exclude<ExportFormat, 'burn'>) => {
    setAnimatingFormat(format);
    setReadyDownload(null);

    for (let i = 0; i < EXPORT_ANIMATION_STEPS.length; i++) {
      setAnimStepIdx(i);
      await new Promise((r) => setTimeout(r, 180));
    }

    const targetSegments =
      exportWordsMode > 0
        ? regroupSegmentsByWordCount(segments, exportWordsMode)
        : segments;

    const safeTitle = (projectTitle || projectId).replace(/[^a-zA-Z0-9_\-]/g, '_');
    const wordSuffix = exportWordsMode > 0 ? `_${exportWordsMode}w` : '';
    let content = '';
    let mime = 'text/plain;charset=utf-8';
    let ext: string = format;

    if (format === 'srt') {
      content = buildSrt(targetSegments);
    } else if (format === 'vtt') {
      content = buildVtt(targetSegments);
      mime = 'text/vtt;charset=utf-8';
    } else if (format === 'txt') {
      content = buildTxt(targetSegments);
    } else if (format === 'markdown') {
      content = buildMarkdown(projectTitle, targetSegments, analysis);
      mime = 'text/markdown;charset=utf-8';
      ext = 'md';
    } else if (format === 'word') {
      content = buildWordDocHtml(projectTitle, targetSegments, analysis);
      mime = 'application/msword;charset=utf-8';
      ext = 'doc';
    } else if (format === 'pdf') {
      content = buildWordDocHtml(projectTitle, targetSegments, analysis);
      mime = 'text/html;charset=utf-8';
      ext = 'html';
    }

    const blob = new Blob([content], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    const fileName = `${safeTitle}${wordSuffix}.${ext}`;

    setReadyDownload({ format, blobUrl, fileName });
    triggerBlobUrlDownload(blobUrl, fileName);

    try {
      await syncSegmentsToBackend(projectId, targetSegments).catch(() => {});
      const res = await startProjectExport({
        projectId,
        uid: uid || 'local_user',
        format,
        segments: targetSegments,
        wordsPerSegment: exportWordsMode,
      });
      if (uid && (format === 'srt' || format === 'vtt' || format === 'txt')) {
        await createFirestoreExport({
          id: res.exportId,
          ownerId: uid,
          projectId,
          format,
          outputPath: res.outputPath,
          url: res.downloadUrl,
          fontUsed: 'none',
          createdBy: uid,
        });
      }
    } catch {
      // Non-blocking
    }
  };

  /**
   * Burns the current subtitles & current CaptionTemplate design into the MP4 video via FFmpeg
   * and downloads the resulting MP4 in 4MB binary chunks so Cloud Run never returns HTTP 500
   * and no "cookie" file ever appears.
   */
  const handleBurnVideo = async () => {
    setIsBurning(true);
    setBurnError(null);
    setBurnProgressText(`Burning subtitles with FFmpeg (${activeTemplate.font})...`);
    if (latestBurnUrl && latestBurnUrl.startsWith('blob:')) {
      URL.revokeObjectURL(latestBurnUrl);
    }
    setLatestBurnUrl(null);

    try {
      const targetSegments =
        exportWordsMode > 0
          ? regroupSegmentsByWordCount(segments, exportWordsMode)
          : segments;

      const effectiveUid = uid || 'local_user';
      await syncSegmentsToBackend(projectId, targetSegments).catch(() => {});

      const res = await startProjectExport({
        projectId,
        uid: effectiveUid,
        format: 'burn',
        segments: targetSegments,
        template: activeTemplate,
        wordsPerSegment: exportWordsMode,
      });

      const safeTitle = (projectTitle || projectId).replace(/[^a-zA-Z0-9_\-]/g, '_');
      const safeFont = (activeTemplate.font || 'Khmer').replace(/[^a-zA-Z0-9_\-]/g, '_');
      const mp4FileName = `${safeTitle}_${safeFont}_subtitled.mp4`;
      setLatestBurnFileName(mp4FileName);

      // Download the burned MP4 in 4MB slices so even 50MB-500MB videos never hit Cloud Run's 32MB HTTP 500 cap
      const videoBlob = await downloadExportedFileChunked({
        projectId,
        uid: effectiveUid,
        format: 'burn',
        knownSizeBytes: res.sizeBytes,
        expectedMime: 'video/mp4',
        onProgress: (pct, downloaded, total) => {
          const dlMb = (downloaded / (1024 * 1024)).toFixed(1);
          const totMb = (total / (1024 * 1024)).toFixed(1);
          setBurnProgressText(`Downloading MP4 video... ${pct}% (${dlMb} MB / ${totMb} MB)`);
        },
      });

      const blobUrl = URL.createObjectURL(videoBlob);
      setLatestBurnUrl(blobUrl);
      triggerBlobUrlDownload(blobUrl, mp4FileName);

      if (uid) {
        await createFirestoreExport({
          id: res.exportId,
          ownerId: uid,
          projectId,
          format: 'burn',
          outputPath: res.outputPath,
          url: `/media/${res.outputPath}`,
          fontUsed: res.fontUsed,
          createdBy: uid,
        });
      }
    } catch (err) {
      setBurnError(err instanceof Error ? err.message : 'FFmpeg burn-in failed');
    } finally {
      setIsBurning(false);
      setBurnProgressText('');
    }
  };

  const handleDownloadRecentExport = async (item: ExportRecord) => {
    setDownloadingItemId(item.id);
    try {
      const safeTitle = (projectTitle || projectId).replace(/[^a-zA-Z0-9_\-]/g, '_');
      const ext = item.format === 'burn' ? 'mp4' : item.format;
      const mime = item.format === 'burn' ? 'video/mp4' : 'text/plain;charset=utf-8';
      const fileName = `${safeTitle}_${item.format}.${ext}`;

      const blob = await downloadExportedFileChunked({
        projectId,
        uid: uid || item.ownerId || 'local_user',
        format: item.format,
        expectedMime: mime,
      });
      const blobUrl = URL.createObjectURL(blob);
      triggerBlobUrlDownload(blobUrl, fileName);
    } catch {
      // Fallback if server file was cleaned up: regenerate from current studio segments
      if (item.format === 'srt' || item.format === 'vtt' || item.format === 'txt') {
        await handleDownloadCurrentResultDirect(item.format);
      }
    } finally {
      setDownloadingItemId(null);
    }
  };

  const EXPORT_OPTIONS: {
    format: Exclude<ExportFormat, 'burn'>;
    title: string;
    desc: string;
  }[] = [
    { format: 'srt', title: 'SRT', desc: 'Export timed subtitles (1-4 words or full line).' },
    { format: 'vtt', title: 'VTT', desc: 'Export WebVTT subtitles for web players.' },
    { format: 'txt', title: 'TXT', desc: 'Export plain transcript with speaker timecodes.' },
    { format: 'pdf', title: 'PDF / Print', desc: 'Export formatted printable transcript.' },
    { format: 'word', title: 'WORD (.DOC)', desc: 'Export editable Microsoft Word document.' },
    { format: 'markdown', title: 'MARKDOWN (.MD)', desc: 'Export transcript for writing workflows.' },
  ];

  return (
    <div className="border border-slate-800 bg-[#111827] rounded-xl p-5 space-y-5">
      {/* 1. EXACT CURRENT RESULT STATUS CARD & 1-CLICK INSTANT DOWNLOADS */}
      <div className="p-4 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border border-emerald-500/40 rounded-xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Current Result · Exact & Unchanged</span>
            </span>
            <span className="text-xs text-slate-300 font-mono tabular-nums">
              {segments.length} Subtitles · Font:{' '}
              <span className="font-semibold text-amber-400">{activeTemplate.font}</span>
            </span>
          </div>

          <span className="text-[11px] text-slate-400 font-mono">
            {segments.length > 0
              ? `${segments[0].start.toFixed(2)}s → ${segments[segments.length - 1].end.toFixed(2)}s`
              : '0 subtitles'}
          </span>
        </div>

        {/* Live Font Sample of Current Result */}
        {segments.length > 0 && (
          <div className="p-2.5 bg-black/60 border border-slate-800 rounded-lg flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                Khmer Font Preview ({activeTemplate.font}):
              </div>
              <div
                className="text-sm text-slate-100 truncate mt-0.5"
                style={{
                  fontFamily: resolveFontFamilyCss(
                    activeTemplate.font,
                    activeTemplate.customFontName
                  ),
                }}
              >
                {segments[0].text}
              </div>
            </div>
            <div className="shrink-0 text-[11px] text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>UTF-8 BOM Ready</span>
            </div>
          </div>
        )}

        {/* 1-Click Direct Download Buttons for Current Result */}
        <div className="space-y-2 pt-1">
          <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>Instant Direct Download (Exact Current Design & Subtitles):</span>
          </div>

          <button
            type="button"
            onClick={handleBurnVideo}
            disabled={isBurning || segments.length === 0}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg transition-colors whitespace-nowrap shadow-sm"
          >
            {isBurning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>
                  {burnProgressText ||
                    `Burning & Downloading Video (${activeTemplate.font} · Current Design)...`}
                </span>
              </>
            ) : (
              <>
                <Film className="w-4 h-4" />
                <span>
                  Download Video with Subtitles (.MP4 · {activeTemplate.font} · Current Design)
                </span>
              </>
            )}
          </button>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => handleDownloadCurrentResultDirect('srt')}
              disabled={segments.length === 0}
              className="flex items-center justify-center gap-1.5 py-2 px-3 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg transition-colors whitespace-nowrap shadow-sm"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Current .SRT</span>
            </button>

            <button
              type="button"
              onClick={() => handleDownloadCurrentResultDirect('vtt')}
              disabled={segments.length === 0}
              className="flex items-center justify-center gap-1.5 py-2 px-3 bg-slate-900 hover:bg-slate-800 border border-slate-700 disabled:opacity-40 text-slate-200 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              <span>Current .VTT</span>
            </button>

            <button
              type="button"
              onClick={() => handleDownloadCurrentResultDirect('txt')}
              disabled={segments.length === 0}
              className="flex items-center justify-center gap-1.5 py-2 px-3 bg-slate-900 hover:bg-slate-800 border border-slate-700 disabled:opacity-40 text-slate-200 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              <span>Current .TXT</span>
            </button>

            <button
              type="button"
              onClick={() => handleDownloadCurrentResultDirect('word')}
              disabled={segments.length === 0}
              className="flex items-center justify-center gap-1.5 py-2 px-3 bg-slate-900 hover:bg-slate-800 border border-slate-700 disabled:opacity-40 text-slate-200 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-sky-400" />
              <span>Word .DOC</span>
            </button>
          </div>

          {directDownloadNotice && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-300 font-medium pt-1">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{directDownloadNotice}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-100">ADVANCED EXPORT & RE-SEGMENTATION</h3>
        <p className="text-xs text-slate-400 mt-0.5">
          Choose word density per SRT card or keep current result, then export or burn subtitles.
        </p>
      </div>

      {/* SRT Word Count Selector for Export */}
      <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-semibold text-slate-200">
            <TypeIcon className="w-3.5 h-3.5 text-amber-400" />
            <span>Word Density Mode</span>
          </span>
          <span className="font-mono text-amber-400">
            {exportWordsMode === 0
              ? '✓ Current Result (Don’t Change)'
              : `${exportWordsMode} Word${exportWordsMode > 1 ? 's' : ''} per Subtitle`}
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {(
            [
              { value: 0, label: 'Current Result' },
              { value: 1, label: '1 Word' },
              { value: 2, label: '2 Words' },
              { value: 3, label: '3 Words' },
              { value: 4, label: '4 Words' },
            ] as { value: WordsPerSegmentOption; label: string }[]
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setExportWordsMode(opt.value)}
              className={`py-1.5 px-2 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                exportWordsMode === opt.value
                  ? 'bg-amber-400 text-slate-950 font-bold'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400">
          {exportWordsMode === 0
            ? '✓ Preserving exact current subtitles, custom line splits, and timecodes.'
            : `Splitting each subtitle into ${exportWordsMode}-word cards.`}
        </p>
      </div>

      {/* 6 Export Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {EXPORT_OPTIONS.map((opt) => (
          <button
            key={opt.format}
            type="button"
            onClick={() => runAnimatedExport(opt.format)}
            disabled={segments.length === 0}
            className="flex flex-col items-start justify-between p-3.5 bg-slate-950/80 hover:bg-slate-900 border border-slate-800 hover:border-amber-400/50 rounded-lg text-left transition-colors disabled:opacity-40"
          >
            <div className="flex items-center justify-between w-full mb-1">
              <span className="text-xs font-bold text-slate-100">
                {opt.title}
                {exportWordsMode > 0 && opt.format === 'srt' ? ` (${exportWordsMode}W)` : ''}
              </span>
              {opt.format === 'markdown' ? (
                <FileCode className="w-3.5 h-3.5 text-amber-400" />
              ) : opt.format === 'word' ? (
                <FileSpreadsheet className="w-3.5 h-3.5 text-sky-400" />
              ) : (
                <FileText className="w-3.5 h-3.5 text-amber-400" />
              )}
            </div>
            <p className="text-[11px] text-slate-400 leading-snug">{opt.desc}</p>
          </button>
        ))}
      </div>

      {/* Smean SRT Export Animation Box */}
      {animatingFormat && (
        <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2.5">
          <div className="text-xs font-semibold text-slate-200 uppercase">
            {animatingFormat} Export Pipeline{' '}
            {exportWordsMode > 0 ? `(${exportWordsMode} Word${exportWordsMode > 1 ? 's' : ''} Mode)` : ''}
          </div>
          <div className="space-y-1.5">
            {EXPORT_ANIMATION_STEPS.map((stepText, idx) => {
              const isDone = idx < animStepIdx || animStepIdx === EXPORT_ANIMATION_STEPS.length - 1;
              const isCurrent = idx === animStepIdx && animStepIdx < EXPORT_ANIMATION_STEPS.length - 1;
              if (idx > animStepIdx) return null;
              return (
                <div
                  key={stepText}
                  className={`flex items-center gap-2 text-xs ${
                    idx === EXPORT_ANIMATION_STEPS.length - 1
                      ? 'text-emerald-400 font-semibold'
                      : isCurrent
                        ? 'text-amber-300'
                        : 'text-slate-400'
                  }`}
                >
                  {isDone ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                  )}
                  <span>{stepText}</span>
                </div>
              );
            })}
          </div>

          {readyDownload && (
            <div className="pt-2">
              <a
                href={readyDownload.blobUrl}
                download={readyDownload.fileName}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download {readyDownload.fileName}</span>
              </a>
            </div>
          )}
        </div>
      )}

      {/* FFmpeg Burned-in Video Button */}
      <div className="pt-1 border-t border-slate-800 space-y-3">
        <button
          type="button"
          onClick={handleBurnVideo}
          disabled={isBurning || segments.length === 0}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap"
        >
          {isBurning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>
                {burnProgressText ||
                  `Burning & Downloading Video (${activeTemplate.font} · Current Design)...`}
              </span>
            </>
          ) : (
            <>
              <Film className="w-4 h-4" />
              <span>
                Burn & Download Video (MP4 · {activeTemplate.font} · Current Design
                {exportWordsMode > 0 ? ` · ${exportWordsMode}W` : ''})
              </span>
            </>
          )}
        </button>

        {burnError && <p className="text-xs text-rose-400">{burnError}</p>}

        {latestBurnUrl && (
          <div className="flex flex-col gap-2.5 p-3 rounded-lg bg-slate-900 border border-emerald-500/40">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-emerald-300">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>
                  Burned MP4 ready ({activeTemplate.font} · Current Design & Subtitles)!
                </span>
              </div>
              <button
                type="button"
                onClick={() => triggerBlobUrlDownload(latestBurnUrl, latestBurnFileName)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-slate-950 font-semibold text-xs rounded hover:bg-emerald-400 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download MP4 ({latestBurnFileName})</span>
              </button>
            </div>
            <video
              src={latestBurnUrl}
              controls
              className="w-full max-h-52 rounded border border-slate-800 bg-black"
            />
          </div>
        )}
      </div>

      {/* Recent Exports from Firestore */}
      {exportsList.length > 0 && (
        <div className="pt-2 space-y-1.5">
          <div className="text-xs font-medium text-slate-400">
            Recent Exports ({exportsList.length})
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {exportsList.slice(0, 5).map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded bg-slate-950/60 border border-slate-800/80"
              >
                <div className="text-slate-300 font-mono tabular-nums truncate pr-2">
                  <span className="uppercase text-amber-400">{item.format}</span>
                  <span className="mx-1.5 text-slate-600">·</span>
                  <span>{item.outputPath}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDownloadRecentExport(item)}
                  disabled={downloadingItemId === item.id}
                  className="text-amber-400 hover:underline font-medium whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  {downloadingItemId === item.id ? 'Downloading...' : 'Download'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
