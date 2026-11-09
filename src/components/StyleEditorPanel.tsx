import React, { useState, useRef } from 'react';
import {
  Plus,
  Mic,
  Upload as UploadIcon,
  Check,
  Ban,
  Play,
  Sliders,
  Clock,
  Wand2,
} from 'lucide-react';
import {
  AnimateByGranularity,
  AnimationEasing,
  BUILT_IN_TEMPLATES,
  BackgroundOption,
  CaptionFont,
  CaptionPosition,
  CaptionTemplate,
  EntranceAnimation,
  ExitAnimation,
  FontWeightOption,
  KHMER_FONT_CATALOG,
  LoopAnimation,
  ShadowOption,
  SubtitleSegment,
  TextAlignment,
  WordsPerSegmentOption,
  WordAnimation,
  resolveFontFamilyCss,
} from '../../shared/segment.schema';
import { saveFirestoreTemplate } from '../lib/firebase';
import { uploadCustomKhmerFont } from '../lib/api';

interface StyleEditorPanelProps {
  uid: string | null;
  activeTemplate: CaptionTemplate;
  customTemplates: CaptionTemplate[];
  onSelectTemplate: (tpl: CaptionTemplate) => void;
  onUpdateTemplate: (patch: Partial<CaptionTemplate>) => void;
  initialSubTab?: 'style' | 'animate' | 'timing';
  inspectedSegment?: SubtitleSegment | null;
  onShiftAllTimings?: (offsetSec: number) => void;
  onUpdateSegmentTiming?: (segId: string, start: number, end: number) => void;
  onRegroupWords?: (wordsPerSeg: WordsPerSegmentOption) => void;
  onReplayPreview?: () => void;
}

const FONT_WEIGHTS: FontWeightOption[] = [
  'Light',
  'Regular',
  'Medium',
  'Bold',
  'Extra Bold',
];

type StudioSubTab = 'style' | 'animate' | 'timing';
type AnimatePhaseTab = 'in' | 'out' | 'loop';

const IN_ANIMATION_PRESETS: {
  id: EntranceAnimation;
  label: string;
  khmerGlyph: string;
}[] = [
  { id: 'none', label: 'None', khmerGlyph: '' },
  { id: 'fade_in', label: 'Fade', khmerGlyph: 'កខគ' },
  { id: 'rise', label: 'Rise', khmerGlyph: 'កខគ' },
  { id: 'pop', label: 'Pop', khmerGlyph: 'កខគ' },
  { id: 'slide_up', label: 'Slide', khmerGlyph: 'កខគ' },
  { id: 'blur', label: 'Blur', khmerGlyph: 'កខគ' },
  { id: 'zoom', label: 'Zoom', khmerGlyph: 'កខគ' },
  { id: 'wipe', label: 'Wipe', khmerGlyph: 'កខគ' },
  { id: 'typewriter', label: 'Typewriter', khmerGlyph: 'ក ខ គ' },
  { id: 'word_by_word', label: 'Word by word', khmerGlyph: 'ក ខ គ' },
];

const OUT_ANIMATION_PRESETS: {
  id: ExitAnimation;
  label: string;
  khmerGlyph: string;
}[] = [
  { id: 'none', label: 'None', khmerGlyph: '' },
  { id: 'fade_out', label: 'Fade', khmerGlyph: 'កខគ' },
  { id: 'slide_down', label: 'Slide', khmerGlyph: 'កខគ' },
  { id: 'pop_out', label: 'Pop', khmerGlyph: 'កខគ' },
  { id: 'blur_out', label: 'Blur', khmerGlyph: 'កខគ' },
  { id: 'scale_out', label: 'Zoom Out', khmerGlyph: 'កខគ' },
  { id: 'wipe_out', label: 'Wipe', khmerGlyph: 'កខគ' },
];

const LOOP_ANIMATION_PRESETS: {
  id: LoopAnimation;
  label: string;
  khmerGlyph: string;
}[] = [
  { id: 'none', label: 'None', khmerGlyph: '' },
  { id: 'pulse', label: 'Pulse', khmerGlyph: 'កខគ' },
  { id: 'float', label: 'Float', khmerGlyph: 'កខគ' },
  { id: 'glow', label: 'Glow', khmerGlyph: 'កខគ' },
  { id: 'wave', label: 'Wave', khmerGlyph: 'កខគ' },
  { id: 'shake', label: 'Shake', khmerGlyph: 'កខគ' },
  { id: 'breathe', label: 'Breathe', khmerGlyph: 'កខគ' },
];

const EASING_OPTIONS: { id: AnimationEasing; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'ease_in', label: 'Ease in' },
  { id: 'ease_out', label: 'Ease out' },
  { id: 'ease_in_out', label: 'Ease in out' },
  { id: 'overshoot', label: 'Overshoot' },
  { id: 'elastic', label: 'Elastic' },
  { id: 'bounce', label: 'Bounce' },
];

const ANIMATE_BY_OPTIONS: { id: AnimateByGranularity; label: string }[] = [
  { id: 'line', label: 'Line' },
  { id: 'word', label: 'Word' },
  { id: 'character', label: 'Character' },
];

function getInLabel(anim?: EntranceAnimation): string {
  const found = IN_ANIMATION_PRESETS.find((p) => p.id === (anim || 'pop'));
  if (found) return found.label;
  if (anim === 'scale_in') return 'Zoom';
  if (anim === 'slide_down') return 'Slide';
  return 'Pop';
}

function getOutLabel(anim?: ExitAnimation): string {
  const found = OUT_ANIMATION_PRESETS.find((p) => p.id === (anim || 'none'));
  return found ? found.label : 'None';
}

function getLoopLabel(anim?: LoopAnimation): string {
  const found = LOOP_ANIMATION_PRESETS.find((p) => p.id === (anim || 'none'));
  return found ? found.label : 'None';
}

export const StyleEditorPanel: React.FC<StyleEditorPanelProps> = ({
  uid,
  activeTemplate,
  customTemplates,
  onSelectTemplate,
  onUpdateTemplate,
  initialSubTab = 'animate',
  inspectedSegment,
  onShiftAllTimings,
  onUpdateSegmentTiming,
  onRegroupWords,
  onReplayPreview,
}) => {
  const [studioTab, setStudioTab] = useState<StudioSubTab>(initialSubTab);
  const [animPhase, setAnimPhase] = useState<AnimatePhaseTab>('in');
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);

  const [newTemplateName, setNewTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [uploadingFont, setUploadingFont] = useState(false);
  const [uploadedFontLabel, setUploadedFontLabel] = useState<string | null>(null);
  const [shiftDeltaSec, setShiftDeltaSec] = useState('0.25');
  const fontInputRef = useRef<HTMLInputElement | null>(null);

  const allTemplates: CaptionTemplate[] = [
    ...BUILT_IN_TEMPLATES.map((t) => ({ ...t, ownerId: 'system' })),
    ...customTemplates,
  ];

  const handleUploadFontFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFont(true);
    try {
      const res = await uploadCustomKhmerFont(file);
      const buffer = await file.arrayBuffer();
      const fontFace = new FontFace(res.fontFamilyName, buffer);
      await fontFace.load();
      document.fonts.add(fontFace);

      setUploadedFontLabel(res.fontFamilyName);
      onUpdateTemplate({
        font: 'Custom Font',
        customFontName: res.fontFamilyName,
      });
    } catch {
      try {
        const family = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
        const buffer = await file.arrayBuffer();
        const fontFace = new FontFace(family, buffer);
        await fontFace.load();
        document.fonts.add(fontFace);
        setUploadedFontLabel(family);
        onUpdateTemplate({
          font: 'Custom Font',
          customFontName: family,
        });
      } catch {
        // Ignore
      }
    } finally {
      setUploadingFont(false);
      e.target.value = '';
    }
  };

  const handleSaveCustomTemplate = async () => {
    if (!uid || !newTemplateName.trim()) return;
    setSavingTemplate(true);
    try {
      const tpl: CaptionTemplate = {
        ...activeTemplate,
        id: `tpl_${Date.now().toString(36)}`,
        ownerId: uid,
        name: newTemplateName.trim().slice(0, 100),
      };
      await saveFirestoreTemplate(tpl);
      setNewTemplateName('');
    } finally {
      setSavingTemplate(false);
    }
  };

  const currentInAnim: EntranceAnimation = activeTemplate.entranceAnimation || 'pop';
  const currentOutAnim: ExitAnimation = activeTemplate.exitAnimation || 'none';
  const currentLoopAnim: LoopAnimation = activeTemplate.loopAnimation || 'none';
  const currentEasing: AnimationEasing = activeTemplate.animationEasing || 'overshoot';
  const currentAnimateBy: AnimateByGranularity = activeTemplate.animateBy || 'word';

  const activeDurationValue =
    animPhase === 'in'
      ? (activeTemplate.animationDuration ?? 0.4)
      : animPhase === 'out'
        ? (activeTemplate.outAnimationDuration ?? 0.3)
        : (activeTemplate.loopAnimationDuration ?? 1.2);

  const handleDurationChange = (val: number) => {
    if (animPhase === 'in') {
      onUpdateTemplate({ animationDuration: val });
    } else if (animPhase === 'out') {
      onUpdateTemplate({ outAnimationDuration: val });
    } else {
      onUpdateTemplate({ loopAnimationDuration: val });
    }
  };

  const getPreviewGlyphStyle = (id: string, isSelected: boolean): React.CSSProperties => {
    const isHovered = hoveredCardId === id;
    if (!isSelected && !isHovered) return {};
    switch (id) {
      case 'pop':
      case 'pop_out':
        return { transform: 'scale(1.18)', transition: 'transform 240ms cubic-bezier(0.34, 1.56, 0.64, 1)' };
      case 'rise':
      case 'slide_up':
        return { transform: 'translateY(-4px)', transition: 'transform 220ms ease-out' };
      case 'slide_down':
        return { transform: 'translateY(4px)', transition: 'transform 220ms ease-out' };
      case 'blur':
      case 'blur_out':
        return { filter: isHovered ? 'blur(1.2px)' : 'blur(0px)', transition: 'filter 220ms ease' };
      case 'zoom':
      case 'scale_in':
      case 'scale_out':
        return { transform: 'scale(1.12)', transition: 'transform 220ms ease-out' };
      case 'pulse':
      case 'breathe':
        return { transform: 'scale(1.1)', transition: 'transform 300ms ease-in-out' };
      case 'glow':
        return { textShadow: '0 0 12px rgba(168, 85, 247, 0.95)' };
      default:
        return {};
    }
  };

  return (
    <div className="border border-slate-800 bg-[#0E0E14] rounded-xl p-4 sm:p-5 space-y-5">
      {/* Top 3-Tab Studio Switcher: Style | Animate | Timing */}
      <div className="grid grid-cols-3 gap-1 p-1 bg-[#161621] border border-white/5 rounded-xl">
        {(
          [
            { id: 'style', label: 'Style' },
            { id: 'animate', label: 'Animate' },
            { id: 'timing', label: 'Timing' },
          ] as { id: StudioSubTab; label: string }[]
        ).map((tab) => {
          const active = studioTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStudioTab(tab.id)}
              className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
                active
                  ? 'bg-[#0B0B10] text-white shadow-sm border border-white/10'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* =====================================================================
          TAB 2: STUDIO ANIMATE PANEL (Matches Reference Screenshot 1:1)
         ===================================================================== */}
      {studioTab === 'animate' && (
        <div className="space-y-5">
          {/* Sub-segmented bar: In · Pop | Out · None | Loop · None */}
          <div className="grid grid-cols-3 gap-1 p-1 bg-[#161621] border border-white/5 rounded-xl">
            <button
              type="button"
              onClick={() => setAnimPhase('in')}
              className={`py-2 px-2.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap truncate ${
                animPhase === 'in'
                  ? 'bg-[#0B0B10] text-white shadow-sm border border-white/10'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              In · {getInLabel(currentInAnim)}
            </button>

            <button
              type="button"
              onClick={() => setAnimPhase('out')}
              className={`py-2 px-2.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap truncate ${
                animPhase === 'out'
                  ? 'bg-[#0B0B10] text-white shadow-sm border border-white/10'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Out · {getOutLabel(currentOutAnim)}
            </button>

            <button
              type="button"
              onClick={() => setAnimPhase('loop')}
              className={`py-2 px-2.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap truncate ${
                animPhase === 'loop'
                  ? 'bg-[#0B0B10] text-white shadow-sm border border-white/10'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Loop · {getLoopLabel(currentLoopAnim)}
            </button>
          </div>

          {/* 3-Column Visual Khmer Animation Preset Cards Grid */}
          {animPhase === 'in' && (
            <div className="grid grid-cols-3 gap-2.5">
              {IN_ANIMATION_PRESETS.map((item) => {
                const isSelected =
                  currentInAnim === item.id ||
                  (currentInAnim === 'scale_in' && item.id === 'zoom') ||
                  (currentInAnim === 'slide_down' && item.id === 'slide_up');
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setHoveredCardId(item.id)}
                    onMouseLeave={() => setHoveredCardId(null)}
                    onClick={() => {
                      const patch: Partial<CaptionTemplate> = {
                        entranceAnimation: item.id,
                      };
                      if (item.id === 'word_by_word') {
                        patch.wordAnimation = 'word_by_word';
                        patch.animateBy = 'word';
                      }
                      onUpdateTemplate(patch);
                      if (onReplayPreview) onReplayPreview();
                    }}
                    className={`h-20 rounded-xl border flex flex-col items-center justify-center gap-1.5 px-2 transition-all select-none ${
                      isSelected
                        ? 'bg-[#2B1644] border-[#9353D3] text-white shadow-[0_0_0_1px_rgba(147,83,211,0.4)]'
                        : 'bg-[#181822] border-white/5 text-slate-300 hover:bg-[#1F1F2C] hover:border-white/15'
                    }`}
                  >
                    <div className="h-6 flex items-center justify-center">
                      {item.id === 'none' ? (
                        <Ban className="w-4 h-4 text-slate-500" />
                      ) : (
                        <span
                          className="text-sm font-bold tracking-wider text-white"
                          style={{
                            fontFamily: resolveFontFamilyCss(
                              activeTemplate.font,
                              activeTemplate.customFontName
                            ),
                            ...getPreviewGlyphStyle(item.id, isSelected),
                          }}
                        >
                          {item.khmerGlyph}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] font-medium text-slate-300 whitespace-nowrap">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {animPhase === 'out' && (
            <div className="grid grid-cols-3 gap-2.5">
              {OUT_ANIMATION_PRESETS.map((item) => {
                const isSelected = currentOutAnim === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setHoveredCardId(item.id)}
                    onMouseLeave={() => setHoveredCardId(null)}
                    onClick={() => {
                      onUpdateTemplate({ exitAnimation: item.id });
                      if (onReplayPreview) onReplayPreview();
                    }}
                    className={`h-20 rounded-xl border flex flex-col items-center justify-center gap-1.5 px-2 transition-all select-none ${
                      isSelected
                        ? 'bg-[#2B1644] border-[#9353D3] text-white shadow-[0_0_0_1px_rgba(147,83,211,0.4)]'
                        : 'bg-[#181822] border-white/5 text-slate-300 hover:bg-[#1F1F2C] hover:border-white/15'
                    }`}
                  >
                    <div className="h-6 flex items-center justify-center">
                      {item.id === 'none' ? (
                        <Ban className="w-4 h-4 text-slate-500" />
                      ) : (
                        <span
                          className="text-sm font-bold tracking-wider text-white"
                          style={{
                            fontFamily: resolveFontFamilyCss(
                              activeTemplate.font,
                              activeTemplate.customFontName
                            ),
                            ...getPreviewGlyphStyle(item.id, isSelected),
                          }}
                        >
                          {item.khmerGlyph}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] font-medium text-slate-300 whitespace-nowrap">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {animPhase === 'loop' && (
            <div className="grid grid-cols-3 gap-2.5">
              {LOOP_ANIMATION_PRESETS.map((item) => {
                const isSelected = currentLoopAnim === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setHoveredCardId(item.id)}
                    onMouseLeave={() => setHoveredCardId(null)}
                    onClick={() => {
                      onUpdateTemplate({ loopAnimation: item.id });
                      if (onReplayPreview) onReplayPreview();
                    }}
                    className={`h-20 rounded-xl border flex flex-col items-center justify-center gap-1.5 px-2 transition-all select-none ${
                      isSelected
                        ? 'bg-[#2B1644] border-[#9353D3] text-white shadow-[0_0_0_1px_rgba(147,83,211,0.4)]'
                        : 'bg-[#181822] border-white/5 text-slate-300 hover:bg-[#1F1F2C] hover:border-white/15'
                    }`}
                  >
                    <div className="h-6 flex items-center justify-center">
                      {item.id === 'none' ? (
                        <Ban className="w-4 h-4 text-slate-500" />
                      ) : (
                        <span
                          className="text-sm font-bold tracking-wider text-white"
                          style={{
                            fontFamily: resolveFontFamilyCss(
                              activeTemplate.font,
                              activeTemplate.customFontName
                            ),
                            ...getPreviewGlyphStyle(item.id, isSelected),
                          }}
                        >
                          {item.khmerGlyph}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] font-medium text-slate-300 whitespace-nowrap">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Duration Slider (0.1s — 2.0s) */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300 font-medium">Duration</span>
              <span className="font-mono text-white font-semibold tabular-nums">
                {activeDurationValue.toFixed(1)} s
              </span>
            </div>
            <input
              type="range"
              min={0.1}
              max={2.0}
              step={0.1}
              value={activeDurationValue}
              onChange={(e) => handleDurationChange(Number(e.target.value))}
              className="w-full h-1.5 bg-[#262636] rounded-lg appearance-none cursor-pointer accent-[#9353D3]"
            />
          </div>

          {/* Easing Selector Buttons */}
          <div className="space-y-2.5">
            <div className="text-xs text-slate-300 font-medium">Easing</div>
            <div className="flex flex-wrap gap-2">
              {EASING_OPTIONS.map((ease) => {
                const isSelected = currentEasing === ease.id;
                return (
                  <button
                    key={ease.id}
                    type="button"
                    onClick={() => {
                      onUpdateTemplate({ animationEasing: ease.id });
                      if (onReplayPreview) onReplayPreview();
                    }}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-medium border transition-all whitespace-nowrap ${
                      isSelected
                        ? 'bg-[#2B1644] border-[#9353D3] text-white font-semibold'
                        : 'bg-[#181822] border-white/10 text-slate-300 hover:bg-[#222230]'
                    }`}
                  >
                    {ease.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Animate By (Line | Word | Character) + Karaoke Mode */}
          <div className="space-y-2.5 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-300 font-medium">Animate by</span>
              <button
                type="button"
                onClick={() =>
                  onUpdateTemplate({
                    wordAnimation:
                      activeTemplate.wordAnimation === 'karaoke' ? 'none' : 'karaoke',
                  })
                }
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors whitespace-nowrap ${
                  activeTemplate.wordAnimation === 'karaoke'
                    ? 'bg-amber-400 border-amber-400 text-slate-950'
                    : 'bg-[#181822] border-white/10 text-slate-300 hover:border-amber-400/50'
                }`}
              >
                <Mic className="w-3 h-3" />
                <span>
                  {activeTemplate.wordAnimation === 'karaoke'
                    ? 'Karaoke Word Glow: ON'
                    : 'Karaoke Word Glow'}
                </span>
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {ANIMATE_BY_OPTIONS.map((opt) => {
                const isSelected = currentAnimateBy === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      const patch: Partial<CaptionTemplate> = { animateBy: opt.id };
                      if (opt.id === 'word' && activeTemplate.wordAnimation === 'none') {
                        patch.wordAnimation = 'highlight';
                      } else if (opt.id === 'line' && activeTemplate.wordAnimation === 'word_by_word') {
                        patch.wordAnimation = 'none';
                      }
                      onUpdateTemplate(patch);
                      if (onReplayPreview) onReplayPreview();
                    }}
                    className={`py-2 px-3 rounded-xl text-xs font-medium border transition-all whitespace-nowrap ${
                      isSelected
                        ? 'bg-[#2B1644] border-[#9353D3] text-white font-semibold'
                        : 'bg-[#181822] border-white/10 text-slate-300 hover:bg-[#222230]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 1: STYLE & KHMER TYPOGRAPHY PANEL
         ===================================================================== */}
      {studioTab === 'style' && (
        <div className="space-y-5">
          {/* Style Presets */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {allTemplates.map((tpl) => {
              const isSelected = activeTemplate.id === tpl.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => onSelectTemplate({ ...activeTemplate, ...tpl })}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    isSelected
                      ? 'border-amber-400 bg-slate-900 text-slate-100'
                      : 'border-slate-800 bg-slate-950/60 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-semibold truncate">{tpl.name}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5 font-mono tabular-nums">
                    {tpl.font} · {tpl.fontSize}px · {tpl.wordAnimation || 'fade'}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 1. KHMER & ENGLISH FONT GALLERY */}
          <div className="space-y-3 pt-2 border-t border-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-200">
                Khmer & English Font ({KHMER_FONT_CATALOG.length} Fonts)
              </div>

              <input
                ref={fontInputRef}
                type="file"
                accept=".ttf,.otf,.woff,.woff2"
                onChange={handleUploadFontFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fontInputRef.current?.click()}
                disabled={uploadingFont}
                className="flex items-center gap-1.5 px-3 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg text-xs font-medium text-amber-400 transition-colors whitespace-nowrap shrink-0"
              >
                <UploadIcon className="w-3.5 h-3.5" />
                <span>
                  {uploadingFont
                    ? 'Uploading Font...'
                    : uploadedFontLabel
                      ? `Custom: ${uploadedFontLabel}`
                      : 'Upload Custom Khmer Font (.TTF / .OTF)'}
                </span>
              </button>
            </div>

            {/* Visual Khmer Font Selector Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
              {KHMER_FONT_CATALOG.map((fontMeta) => {
                const isSelected = activeTemplate.font === fontMeta.id;
                return (
                  <button
                    key={fontMeta.id}
                    type="button"
                    onClick={() => onUpdateTemplate({ font: fontMeta.id })}
                    className={`p-2.5 rounded-lg border text-left transition-colors flex flex-col justify-between ${
                      isSelected
                        ? 'border-amber-400 bg-amber-400/10 text-slate-100'
                        : 'border-slate-800 bg-slate-950/70 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 w-full">
                      <span className="text-[11px] font-semibold text-slate-300 truncate">
                        {fontMeta.label}
                      </span>
                      {isSelected && <Check className="w-3 h-3 text-amber-400 shrink-0" />}
                    </div>
                    <div
                      className="text-sm text-slate-100 mt-1.5 truncate"
                      style={{
                        fontFamily: resolveFontFamilyCss(
                          fontMeta.id,
                          activeTemplate.customFontName
                        ),
                      }}
                    >
                      {fontMeta.khmerSample}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                      {fontMeta.category}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Active Font Family</label>
                <select
                  value={activeTemplate.font}
                  onChange={(e) => onUpdateTemplate({ font: e.target.value as CaptionFont })}
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                >
                  {KHMER_FONT_CATALOG.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1 font-mono tabular-nums">
                  Font Size: {activeTemplate.fontSize} px
                </label>
                <input
                  type="range"
                  min={16}
                  max={64}
                  value={activeTemplate.fontSize}
                  onChange={(e) => onUpdateTemplate({ fontSize: Number(e.target.value) })}
                  className="w-full accent-amber-400 mt-1.5"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Font Weight</label>
                <select
                  value={activeTemplate.fontWeight || 'Bold'}
                  onChange={(e) =>
                    onUpdateTemplate({ fontWeight: e.target.value as FontWeightOption })
                  }
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                >
                  {FONT_WEIGHTS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* 2. COLOR, OUTLINE, SHADOW & BACKGROUND */}
          <div className="space-y-3 pt-2 border-t border-slate-800">
            <div className="text-xs font-semibold text-slate-200">
              Color, Outline, Shadow & Background
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Text Color</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={activeTemplate.primaryColor}
                    onChange={(e) => onUpdateTemplate({ primaryColor: e.target.value })}
                    className="w-7 h-7 rounded bg-transparent border border-slate-700 cursor-pointer"
                  />
                  <span className="text-xs font-mono text-slate-300 tabular-nums">
                    {activeTemplate.primaryColor}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Highlight Color</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={activeTemplate.accentColor}
                    onChange={(e) => onUpdateTemplate({ accentColor: e.target.value })}
                    className="w-7 h-7 rounded bg-transparent border border-slate-700 cursor-pointer"
                  />
                  <span className="text-xs font-mono text-slate-300 tabular-nums">
                    {activeTemplate.accentColor}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1 font-mono tabular-nums">
                  Outline ({activeTemplate.outline} px)
                </label>
                <input
                  type="range"
                  min={0}
                  max={8}
                  value={activeTemplate.outline}
                  onChange={(e) => onUpdateTemplate({ outline: Number(e.target.value) })}
                  className="w-full accent-amber-400 mt-1.5"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Shadow</label>
                <select
                  value={activeTemplate.shadow || 'soft'}
                  onChange={(e) =>
                    onUpdateTemplate({ shadow: e.target.value as ShadowOption })
                  }
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                >
                  <option value="none">None</option>
                  <option value="soft">Soft</option>
                  <option value="strong">Strong</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Background</label>
                <select
                  value={activeTemplate.background || 'rounded'}
                  onChange={(e) =>
                    onUpdateTemplate({ background: e.target.value as BackgroundOption })
                  }
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                >
                  <option value="none">None</option>
                  <option value="transparent">Transparent</option>
                  <option value="box">Box</option>
                  <option value="rounded">Rounded Box</option>
                  <option value="full_width">Full Width</option>
                </select>
              </div>
            </div>
          </div>

          {/* 3. SUBTITLE POSITION & LAYOUT */}
          <div className="space-y-3 pt-2 border-t border-slate-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                Position, Safe Area & Layout
              </span>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(activeTemplate.showSafeArea)}
                  onChange={(e) => onUpdateTemplate({ showSafeArea: e.target.checked })}
                  className="accent-amber-400 rounded"
                />
                <span>Show Safe Area Overlay</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Position</label>
                <select
                  value={activeTemplate.position}
                  onChange={(e) =>
                    onUpdateTemplate({ position: e.target.value as CaptionPosition })
                  }
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                >
                  <option value="bottom">Bottom</option>
                  <option value="middle">Center</option>
                  <option value="top">Top</option>
                  <option value="custom">Custom (X / Y)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1 font-mono tabular-nums">
                  X Position ({activeTemplate.customX ?? 50}%)
                </label>
                <input
                  type="range"
                  min={10}
                  max={90}
                  value={activeTemplate.customX ?? 50}
                  onChange={(e) =>
                    onUpdateTemplate({
                      position: 'custom',
                      customX: Number(e.target.value),
                    })
                  }
                  className="w-full accent-amber-400 mt-1.5"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1 font-mono tabular-nums">
                  Y Position ({activeTemplate.customY ?? 85}%)
                </label>
                <input
                  type="range"
                  min={10}
                  max={92}
                  value={activeTemplate.customY ?? 85}
                  onChange={(e) =>
                    onUpdateTemplate({
                      position: 'custom',
                      customY: Number(e.target.value),
                    })
                  }
                  className="w-full accent-amber-400 mt-1.5"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Maximum Lines</label>
                <div className="grid grid-cols-3 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                  {([1, 2, 3] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => onUpdateTemplate({ maxLines: n })}
                      className={`py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                        (activeTemplate.maxLines || 2) === n
                          ? 'bg-slate-800 text-amber-400'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {n} {n === 1 ? 'Line' : 'Lines'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Alignment</label>
                <div className="grid grid-cols-3 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                  {(['left', 'center', 'right'] as TextAlignment[]).map((align) => (
                    <button
                      key={align}
                      type="button"
                      onClick={() => onUpdateTemplate({ alignment: align })}
                      className={`py-1 text-xs font-medium capitalize rounded transition-colors whitespace-nowrap ${
                        (activeTemplate.alignment || 'center') === align
                          ? 'bg-slate-800 text-amber-400'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {align}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1 font-mono tabular-nums">
                  Max chars/line: {activeTemplate.maxCharsPerLine ?? 42}
                </label>
                <input
                  type="range"
                  min={20}
                  max={80}
                  value={activeTemplate.maxCharsPerLine ?? 42}
                  onChange={(e) =>
                    onUpdateTemplate({ maxCharsPerLine: Number(e.target.value) })
                  }
                  className="w-full accent-amber-400 mt-1.5"
                />
              </div>
            </div>
          </div>

          {/* Save Preset to Firestore */}
          {uid && (
            <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
              <input
                type="text"
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                placeholder="Save current style & animation as preset..."
                className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-amber-400"
              />
              <button
                type="button"
                onClick={handleSaveCustomTemplate}
                disabled={!newTemplateName.trim() || savingTemplate}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{savingTemplate ? 'Saving...' : 'Save Preset'}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          TAB 3: STUDIO TIMING & WORD CADENCE PANEL
         ===================================================================== */}
      {studioTab === 'timing' && (
        <div className="space-y-5">
          {/* Active Subtitle Fine Timing */}
          <div className="p-3.5 rounded-xl bg-[#161621] border border-white/5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-[#9353D3]" />
                <span>Active Subtitle Timing</span>
              </span>
              {inspectedSegment && (
                <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                  Duration:{' '}
                  {Math.max(0.1, inspectedSegment.end - inspectedSegment.start).toFixed(2)}s
                </span>
              )}
            </div>

            {inspectedSegment ? (
              <div className="space-y-3">
                <div className="text-xs text-slate-200 truncate px-2.5 py-1.5 rounded bg-[#0B0B10] border border-white/5">
                  {inspectedSegment.text}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1 font-mono">
                      Start Time (s)
                    </label>
                    <input
                      type="number"
                      step={0.05}
                      min={0}
                      value={Number(inspectedSegment.start.toFixed(2))}
                      onChange={(e) => {
                        const nextStart = Math.max(0, Number(e.target.value));
                        if (onUpdateSegmentTiming) {
                          onUpdateSegmentTiming(
                            inspectedSegment.id,
                            nextStart,
                            Math.max(nextStart + 0.2, inspectedSegment.end)
                          );
                        }
                      }}
                      className="w-full px-2.5 py-1.5 bg-[#0B0B10] border border-white/10 rounded-lg text-xs font-mono text-white tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1 font-mono">
                      End Time (s)
                    </label>
                    <input
                      type="number"
                      step={0.05}
                      min={0.2}
                      value={Number(inspectedSegment.end.toFixed(2))}
                      onChange={(e) => {
                        const nextEnd = Math.max(
                          inspectedSegment.start + 0.15,
                          Number(e.target.value)
                        );
                        if (onUpdateSegmentTiming) {
                          onUpdateSegmentTiming(
                            inspectedSegment.id,
                            inspectedSegment.start,
                            nextEnd
                          );
                        }
                      }}
                      className="w-full px-2.5 py-1.5 bg-[#0B0B10] border border-white/10 rounded-lg text-xs font-mono text-white tabular-nums"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-400">
                Select any subtitle line on the timeline or transcript to fine-tune its start and end timing.
              </p>
            )}
          </div>

          {/* Word Cadence / SRT Grouping */}
          {onRegroupWords && (
            <div className="p-3.5 rounded-xl bg-[#161621] border border-white/5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <Wand2 className="w-3.5 h-3.5 text-[#9353D3]" />
                  <span>Subtitle Word Cadence (Words per Caption)</span>
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
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
                    onClick={() => onRegroupWords(opt.value)}
                    className="py-1.5 px-2 rounded-lg text-xs font-medium bg-[#0B0B10] hover:bg-[#2B1644] hover:border-[#9353D3] text-slate-200 border border-white/10 transition-colors whitespace-nowrap"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Global Subtitle Sync Offset */}
          {onShiftAllTimings && (
            <div className="p-3.5 rounded-xl bg-[#161621] border border-white/5 space-y-2.5">
              <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#9353D3]" />
                <span>Global Subtitle Sync Offset (Shift All Timestamps)</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step={0.05}
                  min={0.05}
                  value={shiftDeltaSec}
                  onChange={(e) => setShiftDeltaSec(e.target.value)}
                  className="w-24 px-2.5 py-1.5 bg-[#0B0B10] border border-white/10 rounded-lg text-xs font-mono text-white tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => {
                    const val = Number.parseFloat(shiftDeltaSec);
                    if (Number.isFinite(val) && val > 0) onShiftAllTimings(-val);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#0B0B10] hover:bg-slate-800 text-slate-200 border border-white/10 whitespace-nowrap"
                >
                  - Earlier ({shiftDeltaSec}s)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const val = Number.parseFloat(shiftDeltaSec);
                    if (Number.isFinite(val) && val > 0) onShiftAllTimings(val);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#0B0B10] hover:bg-slate-800 text-slate-200 border border-white/10 whitespace-nowrap"
                >
                  + Later ({shiftDeltaSec}s)
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
