import React, { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { JobRecord } from '../../shared/segment.schema';
import { formatTimestampShort } from '../lib/srt';

interface ProgressBarProps {
  job: JobRecord | null;
  totalDurationSec?: number;
}

const ANIMATED_STATUS_LINES = [
  'Listening to your voice...',
  'Detecting speakers...',
  'Understanding Khmer & English...',
  'Creating your transcript...',
  'Almost ready...',
];

export const ProgressBar: React.FC<ProgressBarProps> = ({
  job,
  totalDurationSec = 320,
}) => {
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const timer = window.setInterval(() => {
      setMsgIndex((prev) => (prev + 1) % ANIMATED_STATUS_LINES.length);
    }, 1100);
    return () => window.clearInterval(timer);
  }, [job?.status]);

  if (!job) return null;

  const pct = Math.min(100, Math.max(8, Math.round((job.progress || 0.16) * 100)));
  const currentSec = Math.round((pct / 100) * totalDurationSec);
  const statusLine =
    job.status === 'done'
      ? 'Transcript & Subtitles Ready!'
      : ANIMATED_STATUS_LINES[msgIndex];

  return (
    <div className="border border-slate-800 bg-[#111827] rounded-xl p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {job.status === 'done' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
            )}
            <h3 className="text-sm font-semibold text-slate-100">
              Transcribing your audio...
            </h3>
          </div>
          <p className="text-sm text-amber-300 font-medium transition-opacity duration-200">
            {statusLine}
          </p>
        </div>

        <div className="text-right font-mono tabular-nums">
          <div className="text-xs text-slate-400">
            {formatTimestampShort(currentSec)} / {formatTimestampShort(totalDurationSec)}
          </div>
          <div className="text-sm font-bold text-amber-400 mt-0.5">
            {pct}% Transcribed
          </div>
        </div>
      </div>

      {/* Segmented Visual Bar + Smooth Track */}
      <div className="space-y-2">
        <div className="w-full h-2.5 bg-slate-950 rounded-lg overflow-hidden border border-slate-800">
          <div
            className="h-full bg-amber-400 transition-transform duration-200 origin-left"
            style={{ transform: `scaleX(${pct / 100})` }}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Listening · Speaker Diarization · Khmer + English ASR</span>
          <span className="font-mono tabular-nums">
            { '█'.repeat(Math.round((pct / 100) * 16)).padEnd(16, '░') }
          </span>
        </div>
      </div>

      {job.error && (
        <div className="flex items-center gap-2 text-xs text-rose-400 pt-1">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{job.error}</span>
        </div>
      )}
    </div>
  );
};
