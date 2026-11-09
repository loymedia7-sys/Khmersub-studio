import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import {
  CaptionFont,
  CaptionTemplate,
  SubtitleSegment,
  WordsPerSegmentOption,
} from '../../shared/segment.schema';
import { buildAss, buildSrt } from '../../src/lib/srt';

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
export const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
export const AUDIO_DIR = path.join(ROOT_DIR, 'audio');
export const EXPORTS_DIR = path.join(ROOT_DIR, 'exports');
export const FONTS_DIR = path.join(ROOT_DIR, 'fonts');

for (const dir of [UPLOADS_DIR, AUDIO_DIR, EXPORTS_DIR, FONTS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Probes video duration in seconds using ffprobe
 */
export async function probeVideoDuration(videoFilePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoFilePath,
    ]);
    const parsed = Number.parseFloat(stdout.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : 18.0;
  } catch {
    return 18.0;
  }
}

/**
 * Checks whether a media file actually contains an audio stream
 */
export async function hasAudioStream(mediaFilePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      mediaFilePath,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Extracts compact 16 kHz mono MP3 (32 kbps) AND 16 kHz mono WAV from any size video file.
 * At 32 kbps mono MP3, 1 minute of audio is only ~240 KB, so even 1-hour videos extract fast and cleanly.
 */
export async function extractAudioToWav(
  videoFilePath: string,
  uid: string,
  projectId: string
): Promise<{
  audioFilePath: string;
  audioMp3Path: string;
  relativeAudioPath: string;
  hasRealAudio: boolean;
}> {
  const userAudioDir = path.join(AUDIO_DIR, uid, projectId);
  fs.mkdirSync(userAudioDir, { recursive: true });
  const audioFilePath = path.join(userAudioDir, 'audio.wav');
  const audioMp3Path = path.join(userAudioDir, 'audio.mp3');
  const relativeAudioPath = `audio/${uid}/${projectId}/audio.mp3`;

  const hasAudio = await hasAudioStream(videoFilePath);

  if (hasAudio) {
    try {
      // Extract compact 16kHz mono MP3 for fast Gemini ASR even on huge video files
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          videoFilePath,
          '-vn',
          '-acodec',
          'libmp3lame',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-b:a',
          '32k',
          audioMp3Path,
        ],
        { maxBuffer: 50 * 1024 * 1024 }
      );

      // Also extract first 10 minutes as WAV for legacy compatibility
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          videoFilePath,
          '-t',
          '600',
          '-vn',
          '-acodec',
          'pcm_s16le',
          '-ar',
          '16000',
          '-ac',
          '1',
          audioFilePath,
        ],
        { maxBuffer: 50 * 1024 * 1024 }
      );

      return { audioFilePath, audioMp3Path, relativeAudioPath, hasRealAudio: true };
    } catch {
      // Fallback if audio stream is corrupted
    }
  }

  // If source video has no audio stream, generate a quiet 16kHz mono track so pipeline succeeds
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '18',
    '-acodec',
    'libmp3lame',
    '-b:a',
    '32k',
    audioMp3Path,
  ]);
  fs.copyFileSync(audioMp3Path, audioFilePath);

  return { audioFilePath, audioMp3Path, relativeAudioPath, hasRealAudio: false };
}

/**
 * Splits a long MP3 audio track into smaller chunk files (e.g. 300s = 5 min each)
 * so arbitrarily long videos (30m, 1hr, 2hr) can be transcribed chunk-by-chunk by Gemini.
 */
export async function splitAudioIntoChunksMp3(
  audioMp3Path: string,
  totalDurationSec: number,
  chunkDurationSec = 300
): Promise<{ chunkPath: string; offsetSec: number; durationSec: number }[]> {
  if (totalDurationSec <= chunkDurationSec + 30) {
    return [{ chunkPath: audioMp3Path, offsetSec: 0, durationSec: totalDurationSec }];
  }

  const dir = path.dirname(audioMp3Path);
  const chunks: { chunkPath: string; offsetSec: number; durationSec: number }[] = [];

  for (let offset = 0, idx = 0; offset < totalDurationSec; offset += chunkDurationSec, idx++) {
    const dur = Math.min(chunkDurationSec, totalDurationSec - offset);
    if (dur < 1.0) break;
    const chunkPath = path.join(dir, `chunk_${idx}.mp3`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      String(offset),
      '-t',
      String(dur),
      '-i',
      audioMp3Path,
      '-acodec',
      'copy',
      chunkPath,
    ]);
    chunks.push({ chunkPath, offsetSec: offset, durationSec: dur });
  }

  return chunks;
}

/**
 * Converts standard #RRGGBB hex to ASS &H00BBGGRR& color format
 */
function hexToAssColor(hex: string): string {
  const clean = (hex || '#FFFFFF').replace('#', '');
  if (clean.length !== 6) return '&H00FFFFFF';
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`;
}

/**
 * Maps UI CaptionFont choice to the exact TrueType font family name installed in /app/applet/fonts
 */
export function resolveFfmpegFontName(font?: CaptionFont, customFontName?: string): string {
  if (font === 'Custom Font' && customFontName) {
    return customFontName;
  }
  switch (font) {
    case 'Noto Sans Khmer':
      return 'Noto Sans Khmer';
    case 'Noto Serif Khmer':
      return 'Noto Serif Khmer';
    case 'Kantumruy Pro':
      return 'Kantumruy Pro';
    case 'Battambang':
      return 'Battambang';
    case 'Siemreap':
      return 'Siemreap';
    case 'Hanuman':
      return 'Hanuman';
    case 'Koulen':
      return 'Koulen';
    case 'Moul':
      return 'Moul';
    case 'Bayon':
      return 'Bayon';
    case 'Dangrek':
      return 'Dangrek';
    case 'Preahvihear':
      return 'Preahvihear';
    case 'Bokor':
      return 'Bokor';
    case 'Odor Mean Chey':
      return 'Odor Mean Chey';
    case 'Content':
      return 'Content';
    case 'Suwannaphum':
      return 'Suwannaphum';
    case 'Khmer UI':
      return 'Noto Sans Khmer';
    case 'English Sans':
    case 'Plus Jakarta Sans':
      return 'Noto Sans Khmer';
    default:
      return 'Noto Sans Khmer';
  }
}

/**
 * Probes video width and height using ffprobe
 */
export async function probeVideoDimensions(
  videoFilePath: string
): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=s=x:p=0',
      videoFilePath,
    ]);
    const parts = stdout.trim().split('x');
    const width = Number.parseInt(parts[0] || '1920', 10);
    const height = Number.parseInt(parts[1] || '1080', 10);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  } catch {
    // Fallback below
  }
  return { width: 1920, height: 1080 };
}

/**
 * Burns subtitles into video using FFmpeg libass with native HarfBuzz Khmer font shaping
 * via direct Advanced SubStation Alpha (.ass) format.
 */
export async function burnSubtitlesWithFfmpeg(params: {
  videoFilePath: string;
  uid: string;
  projectId: string;
  segments: SubtitleSegment[];
  template?: CaptionTemplate;
  wordsPerSegment?: WordsPerSegmentOption;
}): Promise<{
  burnedFilePath: string;
  relativeOutputPath: string;
  fontUsed: string;
  sizeBytes: number;
}> {
  const exportDir = path.join(EXPORTS_DIR, params.uid, params.projectId);
  fs.mkdirSync(exportDir, { recursive: true });

  const assPath = path.join(exportDir, 'burn_source.ass');
  const burnedFilePath = path.join(exportDir, 'burned.mp4');
  const relativeOutputPath = `exports/${params.uid}/${params.projectId}/burned.mp4`;

  const fontName = resolveFfmpegFontName(
    params.template?.font,
    params.template?.customFontName
  );

  const { width, height } = await probeVideoDimensions(params.videoFilePath);
  const targetRatio = params.template?.aspectRatio || 'original';
  const scaleMode = params.template?.scaleMode || 'fit';

  let playResX = 1920;
  let playResY = 1080;
  if (targetRatio === '9:16') {
    playResX = 1080;
    playResY = 1920;
  } else if (targetRatio === '16:9') {
    playResX = 1920;
    playResY = 1080;
  } else if (targetRatio === '1:1') {
    playResX = 1080;
    playResY = 1080;
  } else if (targetRatio === '4:5') {
    playResX = 1080;
    playResY = 1350;
  } else if (targetRatio === '4:3') {
    playResX = 1440;
    playResY = 1080;
  } else {
    const isOrigVertical = height > width;
    const isOrigSquare = Math.abs(width - height) < 60;
    playResX = isOrigVertical ? 1080 : isOrigSquare ? 1080 : 1920;
    playResY = isOrigVertical ? 1920 : isOrigSquare ? 1080 : 1080;
  }

  const isVertical = playResY > playResX;

  const fontSize = Math.max(
    28,
    Math.min(96, Math.round((params.template?.fontSize || 34) * (isVertical ? 1.45 : 1.5)))
  );
  const outlineWidth = Math.max(1, Math.min(6, params.template?.outline ?? 3));
  const alignment =
    params.template?.position === 'top' ? 8 : params.template?.position === 'middle' ? 5 : 2;

  // Use the exact segments and current template design directly so the burned MP4 matches the studio preview
  const assContent = buildAss(
    params.segments,
    fontName,
    fontSize,
    params.template?.primaryColor || '#FFFFFF',
    outlineWidth,
    alignment,
    params.template,
    playResX,
    playResY
  );
  fs.writeFileSync(assPath, assContent, 'utf-8');

  const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const escapedFontsDir = FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');
  const assFilter = `ass='${escapedAssPath}':fontsdir='${escapedFontsDir}'`;

  let scalePrefix = '';
  if (targetRatio !== 'original') {
    if (scaleMode === 'fill') {
      scalePrefix = `scale=${playResX}:${playResY}:force_original_aspect_ratio=increase,crop=${playResX}:${playResY},setsar=1,`;
    } else {
      scalePrefix = `scale=${playResX}:${playResY}:force_original_aspect_ratio=decrease,pad=${playResX}:${playResY}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,`;
    }
  } else {
    const maxDim = Math.max(width, height);
    if (maxDim > 1920) {
      scalePrefix = isVertical ? 'scale=1080:-2,' : 'scale=1920:-2,';
    }
  }
  const vfFilter = `${scalePrefix}${assFilter}`;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      params.videoFilePath,
      '-vf',
      vfFilter,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-maxrate',
      '8M',
      '-bufsize',
      '16M',
      '-r',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      burnedFilePath,
    ],
    { maxBuffer: 100 * 1024 * 1024 }
  );

  const stat = fs.statSync(burnedFilePath);
  return {
    burnedFilePath,
    relativeOutputPath,
    fontUsed: params.template?.font || fontName,
    sizeBytes: stat.size,
  };
}

/**
 * Generates a real playable 18-second studio broadcast MP4 clip using FFmpeg
 * so users can immediately test Khmer+English transcription, timeline scrubbing, and FFmpeg burn-in.
 */
export async function ensureDemoVideoClip(uid: string, projectId: string): Promise<{
  videoFilePath: string;
  relativeVideoPath: string;
  durationSec: number;
  sizeBytes: number;
}> {
  const targetDir = path.join(UPLOADS_DIR, uid, projectId);
  fs.mkdirSync(targetDir, { recursive: true });
  const videoFilePath = path.join(targetDir, 'video.mp4');
  const relativeVideoPath = `uploads/${uid}/${projectId}/video.mp4`;

  if (!fs.existsSync(videoFilePath)) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=24:duration=18',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000:duration=18',
      '-filter_complex',
      '[1:a]volume=0.06[aout]',
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      videoFilePath,
    ]);
  }

  const stat = fs.statSync(videoFilePath);
  return {
    videoFilePath,
    relativeVideoPath,
    durationSec: 18.0,
    sizeBytes: stat.size,
  };
}
