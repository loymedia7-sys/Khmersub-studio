/**
 * Shared Data Models, Validation Constants, and Schemas for Khmersub Studio
 * Synchronized verbatim with firebase-blueprint.json
 */

export const VALIDATION_LIMITS = {
  ID_MAX_LEN: 128,
  ID_PATTERN: /^[a-zA-Z0-9_\-]+$/,
  DISPLAY_NAME_MAX_LEN: 100,
  EMAIL_MAX_LEN: 254,
  PROJECT_TITLE_MIN_LEN: 1,
  PROJECT_TITLE_MAX_LEN: 200,
  PATH_MAX_LEN: 500,
  URL_MAX_LEN: 1000,
  SEGMENT_TEXT_MAX_LEN: 1000,
  SPEAKER_MAX_LEN: 100,
  ERROR_MAX_LEN: 500,
  TEMPLATE_NAME_MAX_LEN: 100,
  HEX_COLOR_PATTERN: /^#[0-9A-Fa-f]{6}$/,
  MAX_TAGS: 10,
  TAG_MAX_LEN: 50,
} as const;

export type LanguageOption = 'km' | 'en' | 'km+en';
export type SegmentLang = 'km' | 'en' | 'mixed';
export type ProjectStatus = 'uploaded' | 'transcribing' | 'ready' | 'exporting' | 'done' | 'failed';
export type JobType = 'transcribe' | 'export_srt' | 'export_vtt' | 'export_txt' | 'export_burn';
export type JobStatus =
  | 'pending'
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'running'
  | 'completed'
  | 'done'
  | 'failed'
  | 'cancelled';
export type JobStep = 'queued' | 'extract_audio' | 'asr' | 'postprocess' | 'save' | 'burn_subtitles' | 'completed';
export type AsrProvider = 'gemini' | 'whisper' | 'ffmpeg';
export type ExportFormat = 'srt' | 'vtt' | 'txt' | 'pdf' | 'word' | 'markdown' | 'burn';

/**
 * Word grouping per SRT / subtitle cue:
 * 0 = Full Sentence / Phrase (Standard)
 * 1 = 1 Word per subtitle
 * 2 = 2 Words per subtitle
 * 3 = 3 Words per subtitle
 * 4 = 4 Words per subtitle
 */
export type WordsPerSegmentOption = 0 | 1 | 2 | 3 | 4;

export type CaptionFont =
  | 'Battambang'
  | 'Noto Sans Khmer'
  | 'Noto Serif Khmer'
  | 'Kantumruy Pro'
  | 'Siemreap'
  | 'Hanuman'
  | 'Koulen'
  | 'Moul'
  | 'Bayon'
  | 'Dangrek'
  | 'Preahvihear'
  | 'Bokor'
  | 'Odor Mean Chey'
  | 'Content'
  | 'Suwannaphum'
  | 'Khmer UI'
  | 'English Sans'
  | 'Plus Jakarta Sans'
  | 'Custom Font';

export interface KhmerFontMeta {
  id: CaptionFont;
  label: string;
  khmerSample: string;
  category: string;
}

export const KHMER_FONT_CATALOG: KhmerFontMeta[] = [
  { id: 'Battambang', label: 'Battambang (បាត់ដំបង)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Broadcast Standard' },
  { id: 'Noto Sans Khmer', label: 'Noto Sans Khmer (ណូតូសាន)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Modern Clean UI' },
  { id: 'Noto Serif Khmer', label: 'Noto Serif Khmer (ណូតូសេរីហ្វ)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Editorial Serif' },
  { id: 'Kantumruy Pro', label: 'Kantumruy Pro (កន្ទុំរុយ)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Geometric Sans' },
  { id: 'Koulen', label: 'Koulen (គូលែន)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'TikTok / Reels Bold' },
  { id: 'Moul', label: 'Moul (អក្សរមូល)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Traditional Ornamental' },
  { id: 'Siemreap', label: 'Siemreap (សៀមរាប)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Rounded Subtitle' },
  { id: 'Hanuman', label: 'Hanuman (ហនុមាន)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Classic Documentary' },
  { id: 'Dangrek', label: 'Dangrek (ដងរែក)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Playful Pop Caption' },
  { id: 'Bayon', label: 'Bayon (បាយ័ន)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Condensed Display' },
  { id: 'Preahvihear', label: 'Preahvihear (ព្រះវិហារ)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Heritage Khmer' },
  { id: 'Suwannaphum', label: 'Suwannaphum (សុវណ្ណភូមិ)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Crisp TV Caption' },
  { id: 'Bokor', label: 'Bokor (បូកគោ)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Calligraphic Style' },
  { id: 'Odor Mean Chey', label: 'Odor Mean Chey (ឧត្តរមានជ័យ)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Sharp Traditional' },
  { id: 'Content', label: 'Content (កង់តង់)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Reading Body' },
  { id: 'Khmer UI', label: 'Khmer UI (System)', khmerSample: 'សួស្តីអ្នកទាំងអស់គ្នា', category: 'Workspace Default' },
  { id: 'English Sans', label: 'English Sans (Jakarta)', khmerSample: 'Hello Everyone · សួស្តី', category: 'Bilingual Latin' },
  { id: 'Custom Font', label: 'Custom Font (.TTF / .OTF)', khmerSample: 'ពុម្ពអក្សរផ្ទាល់ខ្លួន', category: 'User Uploaded' },
];

export type FontWeightOption = 'Light' | 'Regular' | 'Medium' | 'Bold' | 'Extra Bold';
export type ShadowOption = 'none' | 'soft' | 'strong';
export type BackgroundOption = 'none' | 'transparent' | 'box' | 'rounded' | 'full_width';
export type EntranceAnimation =
  | 'none'
  | 'fade_in'
  | 'rise'
  | 'pop'
  | 'slide_up'
  | 'slide_down'
  | 'blur'
  | 'scale_in'
  | 'zoom'
  | 'wipe'
  | 'typewriter'
  | 'word_by_word';
export type ExitAnimation =
  | 'none'
  | 'fade_out'
  | 'slide_down'
  | 'scale_out'
  | 'pop_out'
  | 'blur_out'
  | 'wipe_out';
export type LoopAnimation =
  | 'none'
  | 'pulse'
  | 'float'
  | 'glow'
  | 'wave'
  | 'shake'
  | 'breathe';
export type AnimationEasing =
  | 'linear'
  | 'ease_in'
  | 'ease_out'
  | 'ease_in_out'
  | 'overshoot'
  | 'elastic'
  | 'bounce';
export type AnimateByGranularity = 'line' | 'word' | 'character';
export type WordAnimation = 'none' | 'word_by_word' | 'karaoke' | 'highlight' | 'bounce';
export type CaptionPosition = 'bottom' | 'middle' | 'top' | 'custom';
export type TextAlignment = 'left' | 'center' | 'right';
export type VideoAspectRatio = 'original' | '9:16' | '16:9' | '1:1' | '4:5' | '4:3';
export type VideoScaleMode = 'fit' | 'fill';

export interface SubtitleSegment {
  id: string;
  ownerId: string;
  projectId: string;
  index: number;
  start: number;
  end: number;
  text: string;
  originalText: string;
  speaker: string;
  lang: SegmentLang;
  confidence: number;
  edited: boolean;
  editedBy: string;
  updatedAt?: unknown;
}

export interface ProjectRecord {
  id: string;
  ownerId: string;
  title: string;
  videoStoragePath: string;
  videoUrl: string;
  localPreviewUrl?: string;
  durationSec: number;
  sizeBytes: number;
  mimeType: string;
  audioPath: string;
  language: LanguageOption;
  status: ProjectStatus;
  segmentCount: number;
  editedCount: number;
  lastJobId: string;
  tags: string[];
  deletedAt: string;
  wordsPerSegment?: WordsPerSegmentOption;
  mediaKind?: 'video' | 'audio' | 'youtube' | 'record';
  pinned?: boolean;
  folder?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface JobRecord {
  id: string;
  ownerId: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  step: JobStep;
  provider: AsrProvider;
  error: string;
  attempts: number;
  maxAttempts?: number;
  lockOwner?: string;
  lockedAt?: number;
  heartbeatAt?: number;
  startedAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
  resultSegments?: SubtitleSegment[];
  exportResult?: {
    format: ExportFormat;
    outputPath: string;
    url: string;
    fontUsed: string;
  };
}

export interface ExportRecord {
  id: string;
  ownerId: string;
  projectId: string;
  format: 'srt' | 'vtt' | 'txt' | 'burn';
  outputPath: string;
  url: string;
  fontUsed: string;
  createdBy: string;
  createdAt?: unknown;
}

export interface CaptionTemplate {
  id: string;
  ownerId: string;
  name: string;
  font: CaptionFont;
  customFontName?: string;
  fontSize: number;
  fontWeight?: FontWeightOption;
  primaryColor: string;
  accentColor: string;
  outline: number;
  shadow?: ShadowOption;
  background?: BackgroundOption;
  position: CaptionPosition;
  customX?: number;
  customY?: number;
  showSafeArea?: boolean;
  maxLines?: 1 | 2 | 3;
  alignment?: TextAlignment;
  maxCharsPerLine?: number;
  entranceAnimation?: EntranceAnimation;
  exitAnimation?: ExitAnimation;
  loopAnimation?: LoopAnimation;
  animationDuration?: number;
  outAnimationDuration?: number;
  loopAnimationDuration?: number;
  animationEasing?: AnimationEasing;
  animateBy?: AnimateByGranularity;
  wordAnimation?: WordAnimation;
  wordsPerSegment?: WordsPerSegmentOption;
  aspectRatio?: VideoAspectRatio;
  scaleMode?: VideoScaleMode;
  isPublic: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserProfileRecord {
  uid: string;
  displayName: string;
  email: string;
  plan: 'free' | 'pro';
  minutesTranscribed: number;
  minutesLimit: number;
  periodStart: string;
  defaultLanguage: LanguageOption;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AiAnalysisResult {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  themes: {
    title: string;
    description: string;
    timestamp: number;
  }[];
  quotes: {
    quote: string;
    speaker: string;
    timestamp: number;
  }[];
  mindMap: {
    root: string;
    branches: {
      label: string;
      children: string[];
    }[];
  };
}

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export const BUILT_IN_TEMPLATES: Omit<CaptionTemplate, 'ownerId' | 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'tpl_modern_khmer',
    name: 'Modern Khmer Broadcast (Battambang)',
    font: 'Battambang',
    fontSize: 32,
    fontWeight: 'Bold',
    primaryColor: '#FFFFFF',
    accentColor: '#FFD60A',
    outline: 3,
    shadow: 'soft',
    background: 'rounded',
    position: 'bottom',
    customX: 50,
    customY: 85,
    showSafeArea: false,
    maxLines: 2,
    alignment: 'center',
    maxCharsPerLine: 42,
    entranceAnimation: 'pop',
    exitAnimation: 'none',
    loopAnimation: 'none',
    animationDuration: 0.4,
    animationEasing: 'overshoot',
    animateBy: 'line',
    wordAnimation: 'none',
    isPublic: true,
  },
  {
    id: 'tpl_phnom_penh_reel',
    name: 'TikTok / Reels Bold (Koulen)',
    font: 'Koulen',
    fontSize: 36,
    fontWeight: 'Extra Bold',
    primaryColor: '#FFFFFF',
    accentColor: '#38BDF8',
    outline: 4,
    shadow: 'strong',
    background: 'none',
    position: 'bottom',
    customX: 50,
    customY: 82,
    showSafeArea: false,
    maxLines: 2,
    alignment: 'center',
    maxCharsPerLine: 36,
    entranceAnimation: 'pop',
    exitAnimation: 'none',
    loopAnimation: 'none',
    animationDuration: 0.4,
    animationEasing: 'overshoot',
    animateBy: 'line',
    wordAnimation: 'none',
    isPublic: true,
  },
  {
    id: 'tpl_angkor_moul',
    name: 'Angkor Royal Title (អក្សរមូល)',
    font: 'Moul',
    fontSize: 30,
    fontWeight: 'Regular',
    primaryColor: '#FDE047',
    accentColor: '#FFFFFF',
    outline: 3,
    shadow: 'strong',
    background: 'transparent',
    position: 'bottom',
    customX: 50,
    customY: 86,
    showSafeArea: false,
    maxLines: 2,
    alignment: 'center',
    maxCharsPerLine: 40,
    entranceAnimation: 'scale_in',
    exitAnimation: 'fade_out',
    loopAnimation: 'none',
    animationDuration: 0.4,
    animationEasing: 'ease_out',
    animateBy: 'line',
    wordAnimation: 'none',
    isPublic: true,
  },
  {
    id: 'tpl_cinema_gold',
    name: 'Documentary Serif (Hanuman)',
    font: 'Hanuman',
    fontSize: 28,
    fontWeight: 'Medium',
    primaryColor: '#FDE047',
    accentColor: '#FFFFFF',
    outline: 2,
    shadow: 'soft',
    background: 'transparent',
    position: 'bottom',
    customX: 50,
    customY: 88,
    showSafeArea: false,
    maxLines: 2,
    alignment: 'center',
    maxCharsPerLine: 48,
    entranceAnimation: 'slide_up',
    exitAnimation: 'fade_out',
    loopAnimation: 'none',
    animationDuration: 0.4,
    animationEasing: 'ease_out',
    animateBy: 'line',
    wordAnimation: 'none',
    isPublic: true,
  },
  {
    id: 'tpl_bilingual_clean',
    name: 'Smean Workspace (Kantumruy Pro)',
    font: 'Kantumruy Pro',
    fontSize: 28,
    fontWeight: 'Bold',
    primaryColor: '#FFFFFF',
    accentColor: '#34D399',
    outline: 2,
    shadow: 'soft',
    background: 'box',
    position: 'bottom',
    customX: 50,
    customY: 86,
    showSafeArea: false,
    maxLines: 2,
    alignment: 'center',
    maxCharsPerLine: 42,
    entranceAnimation: 'fade_in',
    exitAnimation: 'fade_out',
    loopAnimation: 'none',
    animationDuration: 0.4,
    animationEasing: 'ease_out',
    animateBy: 'line',
    wordAnimation: 'none',
    isPublic: true,
  },
];

export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, VALIDATION_LIMITS.ID_MAX_LEN);
  return cleaned || 'id_default';
}

export function clampString(val: string, maxLen: number): string {
  return (val || '').slice(0, maxLen);
}

/**
 * Maps UI font family selection to actual CSS font-family stack
 */
export function resolveFontFamilyCss(font: CaptionFont, customFontName?: string): string {
  switch (font) {
    case 'Khmer UI':
    case 'Kantumruy Pro':
      return '"Kantumruy Pro", "Noto Sans Khmer", sans-serif';
    case 'Noto Sans Khmer':
      return '"Noto Sans Khmer", "Battambang", sans-serif';
    case 'Noto Serif Khmer':
      return '"Noto Serif Khmer", "Hanuman", "Battambang", serif';
    case 'Battambang':
      return '"Battambang", "Noto Sans Khmer", sans-serif';
    case 'Siemreap':
      return '"Siemreap", "Battambang", sans-serif';
    case 'Hanuman':
      return '"Hanuman", "Battambang", serif';
    case 'Koulen':
      return '"Koulen", "Battambang", sans-serif';
    case 'Moul':
      return '"Moul", "Battambang", serif';
    case 'Bayon':
      return '"Bayon", "Koulen", "Battambang", sans-serif';
    case 'Dangrek':
      return '"Dangrek", "Battambang", sans-serif';
    case 'Preahvihear':
      return '"Preahvihear", "Battambang", sans-serif';
    case 'Bokor':
      return '"Bokor", "Battambang", serif';
    case 'Odor Mean Chey':
      return '"Odor Mean Chey", "Battambang", serif';
    case 'Content':
      return '"Content", "Battambang", serif';
    case 'Suwannaphum':
      return '"Suwannaphum", "Battambang", serif';
    case 'English Sans':
    case 'Plus Jakarta Sans':
      return '"Plus Jakarta Sans", "Noto Sans Khmer", sans-serif';
    case 'Custom Font':
      return customFontName
        ? `"${customFontName}", "Battambang", "Noto Sans Khmer", sans-serif`
        : '"Battambang", sans-serif';
    default:
      return '"Battambang", "Noto Sans Khmer", sans-serif';
  }
}

export function resolveFontWeightCss(weight?: FontWeightOption): number {
  switch (weight) {
    case 'Light':
      return 300;
    case 'Regular':
      return 400;
    case 'Medium':
      return 500;
    case 'Bold':
      return 700;
    case 'Extra Bold':
      return 800;
    default:
      return 600;
  }
}
