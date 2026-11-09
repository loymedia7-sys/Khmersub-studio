import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Play,
  Send,
  Loader2,
  Quote,
  GitBranch,
  Languages,
} from 'lucide-react';
import {
  AiAnalysisResult,
  AiChatMessage,
  SubtitleSegment,
} from '../../shared/segment.schema';
import {
  askTranscriptAiChat,
  requestAiAnalysis,
  translateTranscriptSegments,
} from '../lib/api';
import { formatTimestampShort } from '../lib/srt';

interface AiWorkspacePanelProps {
  mode: 'summary' | 'themes' | 'mindmap' | 'chat';
  projectTitle: string;
  segments: SubtitleSegment[];
  analysis: AiAnalysisResult | null;
  onAnalysisLoaded: (res: AiAnalysisResult) => void;
  onSeek: (time: number) => void;
  onReplaceSegments: (newSegs: SubtitleSegment[]) => void;
}

const SUGGESTED_QUESTIONS = [
  'Summarize this recording',
  'What are the key points?',
  'Who said what?',
  'List all decisions',
  'Find important quotes',
  'Translate to English',
  'Translate to Khmer',
];

export const AiWorkspacePanel: React.FC<AiWorkspacePanelProps> = ({
  mode,
  projectTitle,
  segments,
  analysis,
  onAnalysisLoaded,
  onSeek,
  onReplaceSegments,
}) => {
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [translating, setTranslating] = useState<'km' | 'en' | null>(null);
  const [messages, setMessages] = useState<AiChatMessage[]>([
    {
      id: 'msg_welcome',
      role: 'assistant',
      text: 'សួស្តី! Ask anything about your Khmer & English recording — decisions, speaker quotes, summaries, or instant translation.',
      timestamp: 'Now',
    },
  ]);

  useEffect(() => {
    if (!analysis && segments.length > 0 && !loadingAnalysis) {
      setLoadingAnalysis(true);
      requestAiAnalysis({ title: projectTitle, segments })
        .then((res) => onAnalysisLoaded(res))
        .catch(() => {})
        .finally(() => setLoadingAnalysis(false));
    }
  }, [segments.length, projectTitle]);

  const handleSendQuestion = async (qText?: string) => {
    const question = (qText ?? chatInput).trim();
    if (!question || chatLoading) return;
    if (!qText) setChatInput('');

    const userMsg: AiChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      text: question,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages((prev) => [...prev, userMsg]);
    setChatLoading(true);

    try {
      const { answer } = await askTranscriptAiChat({ question, segments });
      setMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: 'assistant',
          text: answer,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleTranslateAll = async (targetLang: 'km' | 'en') => {
    if (translating || segments.length === 0) return;
    setTranslating(targetLang);
    try {
      const { segments: translated } = await translateTranscriptSegments({
        segments,
        targetLang,
      });
      if (translated && translated.length > 0) {
        onReplaceSegments(translated);
      }
    } finally {
      setTranslating(null);
    }
  };

  if (loadingAnalysis && mode !== 'chat') {
    return (
      <div className="border border-slate-800 bg-[#111827] rounded-xl p-8 flex flex-col items-center justify-center text-center space-y-3">
        <Loader2 className="w-6 h-6 text-amber-400 animate-spin" />
        <p className="text-sm font-medium text-slate-200">
          Analyzing Khmer & English transcript with AI...
        </p>
      </div>
    );
  }

  return (
    <div className="border border-slate-800 bg-[#111827] rounded-xl p-5 space-y-5">
      {/* Instant Khmer <-> English Translation Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Languages className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-semibold text-slate-200">
            INSTANT TRANSLATION
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleTranslateAll('en')}
            disabled={translating !== null}
            className="px-3 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-200 transition-colors whitespace-nowrap shrink-0"
          >
            {translating === 'en' ? 'Translating...' : 'KHMER → ENGLISH'}
          </button>
          <button
            type="button"
            onClick={() => handleTranslateAll('km')}
            disabled={translating !== null}
            className="px-3 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg text-amber-300 transition-colors whitespace-nowrap shrink-0"
            style={{ fontFamily: '"Battambang", "Plus Jakarta Sans", sans-serif' }}
          >
            {translating === 'km' ? 'កំពុងបកប្រែ...' : 'ENGLISH → KHMER (បកប្រែទៅខ្មែរ)'}
          </button>
        </div>
      </div>

      {/* MODE 1: AI SUMMARY & KEY QUOTES */}
      {mode === 'summary' && analysis && (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">AI SUMMARY</h3>
              <span className="text-xs text-slate-400">
                Get the key points from your recording in seconds.
              </span>
            </div>
            <p
              className="text-sm text-slate-200 leading-relaxed bg-slate-950/70 p-4 rounded-lg border border-slate-800"
              style={{ fontFamily: '"Battambang", "Plus Jakarta Sans", sans-serif' }}
            >
              {analysis.summary}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-lg space-y-2">
              <h4 className="text-xs font-semibold text-amber-400">KEY POINTS</h4>
              <ul
                className="space-y-1.5 text-xs text-slate-300"
                style={{ fontFamily: '"Battambang", "Plus Jakarta Sans", sans-serif' }}
              >
                {analysis.keyPoints.map((pt, i) => (
                  <li key={i} className="leading-relaxed">
                    • {pt}
                  </li>
                ))}
              </ul>
            </div>

            <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-lg space-y-2">
              <h4 className="text-xs font-semibold text-emerald-400">
                MAIN DECISIONS & ACTIONS
              </h4>
              <ul className="space-y-1.5 text-xs text-slate-300">
                {analysis.decisions.map((d, i) => (
                  <li key={i} className="leading-relaxed">
                    ✓ {d}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* KEY QUOTES */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <Quote className="w-4 h-4 text-amber-400" />
              <h4 className="text-xs font-bold text-slate-100">
                KEY QUOTES — Find the most important statements
              </h4>
            </div>
            <div className="space-y-2">
              {analysis.quotes.map((q, idx) => (
                <div
                  key={idx}
                  onClick={() => onSeek(q.timestamp)}
                  className="p-3 bg-slate-950/80 hover:bg-slate-900 border border-slate-800 rounded-lg cursor-pointer transition-colors flex items-start justify-between gap-3"
                >
                  <div className="space-y-1">
                    <p
                      className="text-xs text-slate-200"
                      style={{ fontFamily: '"Battambang", "Plus Jakarta Sans", sans-serif' }}
                    >
                      “{q.quote}”
                    </p>
                    <p className="text-[11px] text-slate-400">{q.speaker}</p>
                  </div>
                  <button
                    type="button"
                    className="flex items-center gap-1 px-2 py-1 rounded bg-slate-900 text-amber-400 font-mono text-xs tabular-nums shrink-0"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>{formatTimestampShort(q.timestamp)}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MODE 2: KEY THEMES */}
      {mode === 'themes' && analysis && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-bold text-slate-100">KEY THEMES</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Discover the main topics discussed across your Khmer & English recording.
            </p>
          </div>
          <div className="space-y-2.5">
            {analysis.themes.map((theme, idx) => (
              <div
                key={idx}
                onClick={() => onSeek(theme.timestamp)}
                className="p-4 bg-slate-950/80 hover:bg-slate-900 border border-slate-800 rounded-lg cursor-pointer transition-colors flex items-start justify-between gap-4"
              >
                <div className="space-y-1">
                  <div
                    className="text-sm font-semibold text-slate-100"
                    style={{ fontFamily: '"Battambang", "Plus Jakarta Sans", sans-serif' }}
                  >
                    0{idx + 1}. {theme.title}
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    {theme.description}
                  </p>
                </div>
                <button
                  type="button"
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 text-amber-400 font-mono text-xs tabular-nums shrink-0"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>{formatTimestampShort(theme.timestamp)}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MODE 3: MIND MAP */}
      {mode === 'mindmap' && analysis && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">MIND MAP</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Turn your conversation into a visual overview.
              </p>
            </div>
            <GitBranch className="w-4 h-4 text-amber-400" />
          </div>

          <div className="p-5 bg-slate-950 border border-slate-800 rounded-xl space-y-6">
            {/* Root Node */}
            <div className="flex justify-center">
              <div className="px-5 py-2.5 rounded-xl bg-amber-400 text-slate-950 font-bold text-xs shadow">
                {analysis.mindMap.root}
              </div>
            </div>

            {/* Branches */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {analysis.mindMap.branches.map((branch, idx) => (
                <div
                  key={idx}
                  className="p-3.5 rounded-lg bg-[#111827] border border-slate-800 space-y-2.5"
                >
                  <div className="text-xs font-bold text-amber-400 border-b border-slate-800 pb-2">
                    {branch.label}
                  </div>
                  <div className="space-y-1.5">
                    {branch.children.map((child, cIdx) => (
                      <div
                        key={cIdx}
                        className="px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800/80 text-xs text-slate-300"
                      >
                        {child}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MODE 4: AI CHAT ("CHAT WITH YOUR TRANSCRIPT") */}
      {mode === 'chat' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">
                CHAT WITH YOUR TRANSCRIPT
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Ask anything about your recording in Khmer or English.
              </p>
            </div>
            <Sparkles className="w-4 h-4 text-amber-400" />
          </div>

          {/* Suggested Questions */}
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => handleSendQuestion(q)}
                className="px-2.5 py-1 text-xs bg-slate-950 hover:bg-slate-900 text-slate-300 hover:text-amber-300 border border-slate-800 rounded-lg transition-colors whitespace-nowrap"
              >
                {q}
              </button>
            ))}
          </div>

          {/* Message Thread */}
          <div className="h-64 overflow-y-auto space-y-3 p-3.5 bg-slate-950 border border-slate-800 rounded-lg">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${
                  m.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-amber-400 text-slate-950 font-medium'
                      : 'bg-[#111827] border border-slate-800 text-slate-200'
                  }`}
                  style={{ fontFamily: '"Battambang", "Plus Jakarta Sans", sans-serif' }}
                >
                  {m.text}
                </div>
                <span className="text-[10px] font-mono text-slate-500 mt-1">
                  {m.role === 'user' ? 'You' : 'AI Assistant'} · {m.timestamp}
                </span>
              </div>
            ))}
            {chatLoading && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
                <span>AI is analyzing transcript...</span>
              </div>
            )}
          </div>

          {/* Chat Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendQuestion();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask anything about your recording..."
              className="flex-1 px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-amber-400"
            />
            <button
              type="submit"
              disabled={!chatInput.trim() || chatLoading}
              className="flex items-center gap-1.5 px-4 py-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-950 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Ask AI</span>
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
