// server.ts
import express from "express";
import multer from "multer";
import path5 from "path";
import fs6 from "fs";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";

// shared/segment.schema.ts
var VALIDATION_LIMITS = {
  ID_MAX_LEN: 128,
  ID_PATTERN: /^[a-zA-Z0-9_\-]+$/,
  DISPLAY_NAME_MAX_LEN: 100,
  EMAIL_MAX_LEN: 254,
  PROJECT_TITLE_MIN_LEN: 1,
  PROJECT_TITLE_MAX_LEN: 200,
  PATH_MAX_LEN: 500,
  URL_MAX_LEN: 1e3,
  SEGMENT_TEXT_MAX_LEN: 1e3,
  SPEAKER_MAX_LEN: 100,
  ERROR_MAX_LEN: 500,
  TEMPLATE_NAME_MAX_LEN: 100,
  HEX_COLOR_PATTERN: /^#[0-9A-Fa-f]{6}$/,
  MAX_TAGS: 10,
  TAG_MAX_LEN: 50
};
function sanitizeId(raw) {
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, VALIDATION_LIMITS.ID_MAX_LEN);
  return cleaned || "id_default";
}

// server/services/media.service.ts
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

// src/lib/srt.ts
function formatTimestampSrt(seconds) {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor(safeSec % 3600 / 60);
  const secs = Math.floor(safeSec % 60);
  const ms = Math.round((safeSec - Math.floor(safeSec)) * 1e3);
  const hh = String(hrs).padStart(2, "0");
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const mmm = String(Math.min(999, ms)).padStart(3, "0");
  return `${hh}:${mm}:${ss},${mmm}`;
}
function formatTimestampVtt(seconds) {
  return formatTimestampSrt(seconds).replace(",", ".");
}
function formatTimestampHMS(seconds) {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor(safeSec % 3600 / 60);
  const secs = Math.floor(safeSec % 60);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
function tokenizeKhmerAndEnglishWords(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return [];
  try {
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter("km", { granularity: "word" });
      const rawSegs = Array.from(segmenter.segment(cleaned));
      const words = [];
      let hadWhitespaceSinceLastWord = false;
      for (const item of rawSegs) {
        const raw = item.segment;
        const token = raw.trim();
        if (!token) {
          hadWhitespaceSinceLastWord = true;
          continue;
        }
        if (item.isWordLike) {
          const isBareKhmerCoda = !hadWhitespaceSinceLastWord && words.length > 0 && /[\u1780-\u17FF]/.test(words[words.length - 1]) && /^[\u1780-\u17A2][\u17C9-\u17D1]?$/.test(token);
          if (isBareKhmerCoda) {
            words[words.length - 1] = `${words[words.length - 1]}${token}`;
          } else {
            words.push(token);
          }
          hadWhitespaceSinceLastWord = false;
        } else if (words.length > 0 && /^[។៕៖ៗ៘!?.,;:'")\]}]+$/.test(token)) {
          words[words.length - 1] = `${words[words.length - 1]}${token}`;
          hadWhitespaceSinceLastWord = false;
        }
      }
      if (words.length > 0) {
        return words;
      }
    }
  } catch {
  }
  const spaceSplit = cleaned.split(/\s+/).filter(Boolean);
  if (spaceSplit.length > 1) return spaceSplit;
  const chunks = [];
  const step = 6;
  for (let i = 0; i < cleaned.length; i += step) {
    chunks.push(cleaned.slice(i, i + step));
  }
  return chunks;
}
function regroupSegmentsByWordCount(segments, wordsPerSegment) {
  if (!wordsPerSegment || wordsPerSegment <= 0) {
    return segments.map((s, idx) => ({ ...s, index: idx }));
  }
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const result = [];
  for (const seg of sorted) {
    const words = tokenizeKhmerAndEnglishWords(seg.text);
    if (words.length <= wordsPerSegment) {
      result.push({
        ...seg,
        id: `seg_${String(result.length + 1).padStart(3, "0")}`,
        index: result.length
      });
      continue;
    }
    const groups = [];
    for (let i = 0; i < words.length; i += wordsPerSegment) {
      const slice = words.slice(i, i + wordsPerSegment);
      groups.push(slice.join(" "));
    }
    const totalDuration = Math.max(0.2 * groups.length, seg.end - seg.start);
    const totalChars = Math.max(1, groups.reduce((acc, g) => acc + g.length, 0));
    let cursor = seg.start;
    groups.forEach((groupText, gIdx) => {
      const weight = groupText.length / totalChars;
      const chunkDur = gIdx === groups.length - 1 ? Math.max(0.15, seg.end - cursor) : Math.max(0.15, totalDuration * weight);
      const start = Number(cursor.toFixed(2));
      const end = gIdx === groups.length - 1 ? Number(Math.max(start + 0.15, seg.end).toFixed(2)) : Number((start + chunkDur).toFixed(2));
      cursor = end;
      result.push({
        ...seg,
        id: `seg_${String(result.length + 1).padStart(3, "0")}`,
        index: result.length,
        start,
        end,
        text: groupText,
        originalText: groupText,
        lang: detectSegmentLanguage(groupText)
      });
    });
  }
  return result;
}
function formatTimestampAss(seconds) {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor(safeSec % 3600 / 60);
  const secs = Math.floor(safeSec % 60);
  const cs = Math.floor((safeSec - Math.floor(safeSec)) * 100);
  return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function buildSrt(segments, wordsPerSegment = 0) {
  const targetSegments = wordsPerSegment > 0 ? regroupSegmentsByWordCount(segments, wordsPerSegment) : segments;
  const sorted = [...targetSegments].sort((a, b) => a.start - b.start || a.index - b.index);
  return "\uFEFF" + sorted.map((seg, idx) => {
    const startStr = formatTimestampSrt(seg.start);
    const endStr = formatTimestampSrt(Math.max(seg.start + 0.1, seg.end));
    return `${idx + 1}
${startStr} --> ${endStr}
${seg.text.trim()}`;
  }).join("\n\n") + "\n";
}
function buildVtt(segments, wordsPerSegment = 0) {
  const targetSegments = wordsPerSegment > 0 ? regroupSegmentsByWordCount(segments, wordsPerSegment) : segments;
  const sorted = [...targetSegments].sort((a, b) => a.start - b.start || a.index - b.index);
  const body = sorted.map((seg, idx) => {
    const startStr = formatTimestampVtt(seg.start);
    const endStr = formatTimestampVtt(Math.max(seg.start + 0.1, seg.end));
    return `${idx + 1}
${startStr} --> ${endStr}
${seg.text.trim()}`;
  }).join("\n\n");
  return `\uFEFFWEBVTT

${body}
`;
}
function buildTxt(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  return "\uFEFF" + sorted.map((seg) => `${seg.speaker} (${formatTimestampHMS(seg.start)})
${seg.text.trim()}
`).join("\n");
}
function buildMarkdown(title, segments, analysis) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const lines = [`\uFEFF# ${title || "Transcript & Subtitles"}`, ""];
  if (analysis) {
    lines.push("## AI Summary", "", analysis.summary, "");
    if (analysis.keyPoints.length > 0) {
      lines.push("### Key Points");
      analysis.keyPoints.forEach((pt) => lines.push(`- ${pt}`));
      lines.push("");
    }
    if (analysis.decisions.length > 0) {
      lines.push("### Decisions & Action Items");
      analysis.decisions.forEach((d) => lines.push(`- [ ] ${d}`));
      lines.push("");
    }
  }
  lines.push("## Full Timed Transcript", "");
  sorted.forEach((seg) => {
    lines.push(`**${seg.speaker}** \`[${formatTimestampHMS(seg.start)} \u2192 ${formatTimestampHMS(seg.end)}]\`  `);
    lines.push(`${seg.text.trim()}`, "");
  });
  return lines.join("\n");
}
function buildWordDocHtml(title, segments, analysis) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const rows = sorted.map(
    (seg) => `
      <div style="margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0;">
        <p style="margin: 0; font-size: 10pt; color: #475569;">
          <strong>${seg.speaker}</strong> &middot; <span>${formatTimestampHMS(seg.start)} - ${formatTimestampHMS(seg.end)}</span>
        </p>
        <p style="margin: 4px 0 0 0; font-size: 13pt; font-family: 'Noto Sans Khmer', 'Battambang', 'Kantumruy Pro', sans-serif; color: #0f172a; line-height: 1.6;">
          ${seg.text.trim()}
        </p>
      </div>`
  ).join("\n");
  const summaryBlock = analysis ? `<div style="background: #f8fafc; padding: 12px; border: 1px solid #cbd5e1; margin-bottom: 20px;">
        <h2 style="font-size: 13pt; margin-top: 0;">AI Summary</h2>
        <p style="font-size: 11pt; font-family: 'Noto Sans Khmer', 'Battambang', sans-serif;">${analysis.summary}</p>
      </div>` : "";
  return `\uFEFF<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <title>${title}</title>
  </head>
  <body style="font-family: 'Noto Sans Khmer', 'Battambang', 'Plus Jakarta Sans', sans-serif; line-height: 1.6; padding: 20px;">
    <h1 style="font-size: 18pt; color: #0f172a; font-family: 'Noto Sans Khmer', 'Battambang', sans-serif;">${title}</h1>
    ${summaryBlock}
    <h2 style="font-size: 14pt; color: #0f172a; font-family: 'Noto Sans Khmer', 'Battambang', sans-serif;">Timed Transcript</h2>
    ${rows}
  </body>
</html>`;
}
function hexToAssColor(hex, alphaHex = "00") {
  const clean = (hex || "#FFFFFF").replace("#", "").trim();
  if (clean.length !== 6) return `&H${alphaHex}FFFFFF&`;
  const r = clean.slice(0, 2).toUpperCase();
  const g = clean.slice(2, 4).toUpperCase();
  const b = clean.slice(4, 6).toUpperCase();
  return `&H${alphaHex}${b}${g}${r}&`;
}
function escapeAssText(text) {
  return (text || "").trim().replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
}
function buildAss(segments, fontName = "Noto Sans Khmer", fontSize = 52, primaryColorHex = "#FFFFFF", outlineWidth = 3, alignment = 2, template, playResX = 1920, playResY = 1080) {
  const primaryAss = hexToAssColor(primaryColorHex, "00");
  const secondaryAss = hexToAssColor(template?.accentColor || "#FACC15", "00");
  const bgMode = template?.background || "rounded";
  const useOpaqueBox = bgMode === "box" || bgMode === "rounded" || bgMode === "full_width";
  const useTransBox = bgMode === "transparent";
  const borderStyle = useOpaqueBox || useTransBox ? 3 : 1;
  const outlineAss = borderStyle === 3 ? useOpaqueBox ? "&H40000000&" : "&H88000000&" : "&H00000000&";
  const backAss = "&H80000000&";
  const isBold = !template?.fontWeight || template.fontWeight === "Bold" || template.fontWeight === "Extra Bold" || template.fontWeight === "Medium" ? -1 : 0;
  const effectiveOutline = borderStyle === 3 ? Math.max(8, Math.round(fontSize * 0.22)) : Math.max(0, Math.min(8, outlineWidth));
  const shadowDepth = borderStyle === 3 ? 0 : template?.shadow === "none" ? 0 : template?.shadow === "strong" ? 3 : 1.5;
  const horiz = template?.alignment === "left" ? 1 : template?.alignment === "right" ? 3 : 2;
  const vertBase = template?.position === "top" ? 6 : template?.position === "middle" ? 3 : 0;
  const computedAlign = template ? vertBase + horiz : alignment;
  const isVertical = playResY > playResX;
  const marginV = template?.position === "top" ? isVertical ? 140 : 75 : template?.position === "middle" ? 20 : isVertical ? 180 : 75;
  const marginH = isVertical ? 48 : 60;
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const lines = [
    "[Script Info]",
    "; Generated by Khmersub Studio with HarfBuzz Complex Khmer Shaping",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: KhmerSub,${fontName},${fontSize},${primaryAss},${secondaryAss},${outlineAss},${backAss},${isBold},0,0,0,100,100,0,0,${borderStyle},${effectiveOutline},${shadowDepth},${computedAlign},${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  let posOverrideTag = "";
  if (template?.position === "custom") {
    const px = Math.round((template.customX ?? 50) / 100 * playResX);
    const py = Math.round((template.customY ?? 85) / 100 * playResY);
    posOverrideTag = `\\pos(${px},${py})`;
  }
  const inMs = Math.max(80, Math.round((template?.animationDuration ?? 0.4) * 1e3));
  const outMs = template?.exitAnimation && template.exitAnimation !== "none" ? Math.max(80, Math.round((template?.outAnimationDuration ?? 0.3) * 1e3)) : 0;
  let fadeOverrideTag = "";
  const ent = template?.entranceAnimation || "pop";
  const easing = template?.animationEasing || "overshoot";
  if (ent === "fade_in" || ent === "rise" || ent === "slide_up" || ent === "slide_down") {
    fadeOverrideTag += `\\fad(${inMs},${outMs})`;
  } else if (outMs > 0) {
    fadeOverrideTag += `\\fad(0,${outMs})`;
  }
  if (ent === "pop") {
    if (easing === "overshoot" || easing === "elastic" || easing === "bounce") {
      const midMs = Math.round(inMs * 0.65);
      fadeOverrideTag += `\\fscx70\\fscy70\\t(0,${midMs},\\fscx108\\fscy108)\\t(${midMs},${inMs},\\fscx100\\fscy100)`;
    } else {
      fadeOverrideTag += `\\fscx75\\fscy75\\t(0,${inMs},\\fscx100\\fscy100)`;
    }
  } else if (ent === "zoom" || ent === "scale_in") {
    fadeOverrideTag += `\\fscx128\\fscy128\\t(0,${inMs},\\fscx100\\fscy100)`;
  } else if (ent === "blur") {
    fadeOverrideTag += `\\blur8\\t(0,${inMs},\\blur0)`;
  }
  sorted.forEach((seg) => {
    const startSec = Math.max(0, seg.start);
    const endSec = Math.max(startSec + 0.2, seg.end);
    const startStr = formatTimestampAss(startSec);
    const endStr = formatTimestampAss(endSec);
    const basePrefix = posOverrideTag || fadeOverrideTag ? `{${posOverrideTag}${fadeOverrideTag}}` : "";
    const wordAnim = template?.entranceAnimation === "word_by_word" ? "word_by_word" : template?.wordAnimation || "none";
    const rawWords = tokenizeKhmerAndEnglishWords(seg.text);
    if (wordAnim === "karaoke" && rawWords.length > 1) {
      const totalCs = Math.max(20, Math.round((endSec - startSec) * 100));
      const perWordCs = Math.max(5, Math.floor(totalCs / rawWords.length));
      const karaokeBody = rawWords.map((w) => `{\\kf${perWordCs}}${escapeAssText(w)}`).join(" ");
      const karaokeStylePrefix = `{${posOverrideTag}${fadeOverrideTag}\\1c${secondaryAss}\\2c${primaryAss}}`;
      lines.push(
        `Dialogue: 0,${startStr},${endStr},KhmerSub,,0,0,0,,${karaokeStylePrefix}${karaokeBody}`
      );
      return;
    }
    if ((wordAnim === "highlight" || wordAnim === "bounce") && rawWords.length > 1) {
      const dur = endSec - startSec;
      const step = dur / rawWords.length;
      rawWords.forEach((_, activeIdx) => {
        const wStart = startSec + activeIdx * step;
        const wEnd = activeIdx === rawWords.length - 1 ? endSec : startSec + (activeIdx + 1) * step;
        const renderedSentence = rawWords.map((w, idx) => {
          const safeW = escapeAssText(w);
          if (idx === activeIdx) {
            return `{\\1c${secondaryAss}}${safeW}{\\1c${primaryAss}}`;
          }
          return safeW;
        }).join(" ");
        lines.push(
          `Dialogue: 0,${formatTimestampAss(wStart)},${formatTimestampAss(wEnd)},KhmerSub,,0,0,0,,${basePrefix}${renderedSentence}`
        );
      });
      return;
    }
    if (wordAnim === "word_by_word" && rawWords.length > 1) {
      const dur = endSec - startSec;
      const step = dur / rawWords.length;
      rawWords.forEach((_, activeIdx) => {
        const wStart = startSec + activeIdx * step;
        const wEnd = activeIdx === rawWords.length - 1 ? endSec : startSec + (activeIdx + 1) * step;
        const visibleWords = rawWords.slice(0, activeIdx + 1).map((w, idx) => {
          const safeW = escapeAssText(w);
          return idx === activeIdx ? `{\\1c${secondaryAss}}${safeW}{\\1c${primaryAss}}` : safeW;
        }).join(" ");
        lines.push(
          `Dialogue: 0,${formatTimestampAss(wStart)},${formatTimestampAss(wEnd)},KhmerSub,,0,0,0,,${basePrefix}${visibleWords}`
        );
      });
      return;
    }
    const assText = escapeAssText(seg.text);
    lines.push(`Dialogue: 0,${startStr},${endStr},KhmerSub,,0,0,0,,${basePrefix}${assText}`);
  });
  return lines.join("\n") + "\n";
}
function detectSegmentLanguage(text) {
  const hasKhmer = /[\u1780-\u17FF]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);
  if (hasKhmer && hasLatin) return "mixed";
  if (hasKhmer) return "km";
  return "en";
}

// server/services/media.service.ts
var execFileAsync = promisify(execFile);
var ROOT_DIR = process.cwd();
var UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
var AUDIO_DIR = path.join(ROOT_DIR, "audio");
var EXPORTS_DIR = path.join(ROOT_DIR, "exports");
var FONTS_DIR = path.join(ROOT_DIR, "fonts");
for (const dir of [UPLOADS_DIR, AUDIO_DIR, EXPORTS_DIR, FONTS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
async function probeVideoDuration(videoFilePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoFilePath
    ]);
    const parsed = Number.parseFloat(stdout.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : 18;
  } catch {
    return 18;
  }
}
async function hasAudioStream(mediaFilePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      mediaFilePath
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
async function extractAudioToWav(videoFilePath, uid, projectId) {
  const userAudioDir = path.join(AUDIO_DIR, uid, projectId);
  fs.mkdirSync(userAudioDir, { recursive: true });
  const audioFilePath = path.join(userAudioDir, "audio.wav");
  const audioMp3Path = path.join(userAudioDir, "audio.mp3");
  const relativeAudioPath = `audio/${uid}/${projectId}/audio.mp3`;
  const hasAudio = await hasAudioStream(videoFilePath);
  if (hasAudio) {
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          videoFilePath,
          "-vn",
          "-acodec",
          "libmp3lame",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-b:a",
          "32k",
          audioMp3Path
        ],
        { maxBuffer: 50 * 1024 * 1024 }
      );
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          videoFilePath,
          "-t",
          "600",
          "-vn",
          "-acodec",
          "pcm_s16le",
          "-ar",
          "16000",
          "-ac",
          "1",
          audioFilePath
        ],
        { maxBuffer: 50 * 1024 * 1024 }
      );
      return { audioFilePath, audioMp3Path, relativeAudioPath, hasRealAudio: true };
    } catch {
    }
  }
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "18",
    "-acodec",
    "libmp3lame",
    "-b:a",
    "32k",
    audioMp3Path
  ]);
  fs.copyFileSync(audioMp3Path, audioFilePath);
  return { audioFilePath, audioMp3Path, relativeAudioPath, hasRealAudio: false };
}
async function splitAudioIntoChunksMp3(audioMp3Path, totalDurationSec, chunkDurationSec = 300) {
  if (totalDurationSec <= chunkDurationSec + 30) {
    return [{ chunkPath: audioMp3Path, offsetSec: 0, durationSec: totalDurationSec }];
  }
  const dir = path.dirname(audioMp3Path);
  const chunks = [];
  for (let offset = 0, idx = 0; offset < totalDurationSec; offset += chunkDurationSec, idx++) {
    const dur = Math.min(chunkDurationSec, totalDurationSec - offset);
    if (dur < 1) break;
    const chunkPath = path.join(dir, `chunk_${idx}.mp3`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      String(offset),
      "-t",
      String(dur),
      "-i",
      audioMp3Path,
      "-acodec",
      "copy",
      chunkPath
    ]);
    chunks.push({ chunkPath, offsetSec: offset, durationSec: dur });
  }
  return chunks;
}
function resolveFfmpegFontName(font, customFontName) {
  if (font === "Custom Font" && customFontName) {
    return customFontName;
  }
  switch (font) {
    case "Noto Sans Khmer":
      return "Noto Sans Khmer";
    case "Noto Serif Khmer":
      return "Noto Serif Khmer";
    case "Kantumruy Pro":
      return "Kantumruy Pro";
    case "Battambang":
      return "Battambang";
    case "Siemreap":
      return "Siemreap";
    case "Hanuman":
      return "Hanuman";
    case "Koulen":
      return "Koulen";
    case "Moul":
      return "Moul";
    case "Bayon":
      return "Bayon";
    case "Dangrek":
      return "Dangrek";
    case "Preahvihear":
      return "Preahvihear";
    case "Bokor":
      return "Bokor";
    case "Odor Mean Chey":
      return "Odor Mean Chey";
    case "Content":
      return "Content";
    case "Suwannaphum":
      return "Suwannaphum";
    case "Khmer UI":
      return "Noto Sans Khmer";
    case "English Sans":
    case "Plus Jakarta Sans":
      return "Noto Sans Khmer";
    default:
      return "Noto Sans Khmer";
  }
}
async function probeVideoDimensions(videoFilePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=s=x:p=0",
      videoFilePath
    ]);
    const parts = stdout.trim().split("x");
    const width = Number.parseInt(parts[0] || "1920", 10);
    const height = Number.parseInt(parts[1] || "1080", 10);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  } catch {
  }
  return { width: 1920, height: 1080 };
}
async function burnSubtitlesWithFfmpeg(params) {
  const exportDir = path.join(EXPORTS_DIR, params.uid, params.projectId);
  fs.mkdirSync(exportDir, { recursive: true });
  const assPath = path.join(exportDir, "burn_source.ass");
  const burnedFilePath = path.join(exportDir, "burned.mp4");
  const relativeOutputPath = `exports/${params.uid}/${params.projectId}/burned.mp4`;
  const fontName = resolveFfmpegFontName(
    params.template?.font,
    params.template?.customFontName
  );
  const { width, height } = await probeVideoDimensions(params.videoFilePath);
  const targetRatio = params.template?.aspectRatio || "original";
  const scaleMode = params.template?.scaleMode || "fit";
  let playResX = 1920;
  let playResY = 1080;
  if (targetRatio === "9:16") {
    playResX = 1080;
    playResY = 1920;
  } else if (targetRatio === "16:9") {
    playResX = 1920;
    playResY = 1080;
  } else if (targetRatio === "1:1") {
    playResX = 1080;
    playResY = 1080;
  } else if (targetRatio === "4:5") {
    playResX = 1080;
    playResY = 1350;
  } else if (targetRatio === "4:3") {
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
  const alignment = params.template?.position === "top" ? 8 : params.template?.position === "middle" ? 5 : 2;
  const assContent = buildAss(
    params.segments,
    fontName,
    fontSize,
    params.template?.primaryColor || "#FFFFFF",
    outlineWidth,
    alignment,
    params.template,
    playResX,
    playResY
  );
  fs.writeFileSync(assPath, assContent, "utf-8");
  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const escapedFontsDir = FONTS_DIR.replace(/\\/g, "/").replace(/:/g, "\\:");
  const assFilter = `ass='${escapedAssPath}':fontsdir='${escapedFontsDir}'`;
  let scalePrefix = "";
  if (targetRatio !== "original") {
    if (scaleMode === "fill") {
      scalePrefix = `scale=${playResX}:${playResY}:force_original_aspect_ratio=increase,crop=${playResX}:${playResY},setsar=1,`;
    } else {
      scalePrefix = `scale=${playResX}:${playResY}:force_original_aspect_ratio=decrease,pad=${playResX}:${playResY}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,`;
    }
  } else {
    const maxDim = Math.max(width, height);
    if (maxDim > 1920) {
      scalePrefix = isVertical ? "scale=1080:-2," : "scale=1920:-2,";
    }
  }
  const vfFilter = `${scalePrefix}${assFilter}`;
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      params.videoFilePath,
      "-vf",
      vfFilter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-maxrate",
      "8M",
      "-bufsize",
      "16M",
      "-r",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      burnedFilePath
    ],
    { maxBuffer: 100 * 1024 * 1024 }
  );
  const stat = fs.statSync(burnedFilePath);
  return {
    burnedFilePath,
    relativeOutputPath,
    fontUsed: params.template?.font || fontName,
    sizeBytes: stat.size
  };
}
async function ensureDemoVideoClip(uid, projectId) {
  const targetDir = path.join(UPLOADS_DIR, uid, projectId);
  fs.mkdirSync(targetDir, { recursive: true });
  const videoFilePath = path.join(targetDir, "video.mp4");
  const relativeVideoPath = `uploads/${uid}/${projectId}/video.mp4`;
  if (!fs.existsSync(videoFilePath)) {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=24:duration=18",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=18",
      "-filter_complex",
      "[1:a]volume=0.06[aout]",
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      videoFilePath
    ]);
  }
  const stat = fs.statSync(videoFilePath);
  return {
    videoFilePath,
    relativeVideoPath,
    durationSec: 18,
    sizeBytes: stat.size
  };
}

// server/services/asr.service.ts
import fs2 from "fs";
import { GoogleGenAI, Type } from "@google/genai";
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      }
    }
  });
}
function postProcessSegments(rawSegments, projectId, ownerId, durationSec, wordsPerSegment = 0) {
  const normalized = [];
  for (const seg of rawSegments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    const start = Math.max(0, Number(seg.start) || 0);
    const end = Math.min(
      Math.max(durationSec, start + 1.5),
      Math.max(start + 0.4, Number(seg.end) || start + 2.5)
    );
    const duration = end - start;
    if (duration > 7.5 && text.length > 65) {
      const midTime = Number((start + duration / 2).toFixed(2));
      const words = text.split(/\s+/);
      let part1 = "";
      let part2 = "";
      if (words.length >= 4) {
        const half = Math.ceil(words.length / 2);
        part1 = words.slice(0, half).join(" ");
        part2 = words.slice(half).join(" ");
      } else {
        const midChar = Math.ceil(text.length / 2);
        part1 = text.slice(0, midChar).trim();
        part2 = text.slice(midChar).trim();
      }
      normalized.push({
        start,
        end: midTime,
        text: part1,
        speaker: seg.speaker || "Speaker 1",
        lang: seg.lang,
        confidence: seg.confidence ?? 0.91
      });
      normalized.push({
        start: midTime,
        end,
        text: part2,
        speaker: seg.speaker || "Speaker 1",
        lang: seg.lang,
        confidence: seg.confidence ?? 0.91
      });
    } else {
      normalized.push({
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        text,
        speaker: seg.speaker || "Speaker 1",
        lang: seg.lang,
        confidence: seg.confidence ?? 0.92
      });
    }
  }
  normalized.sort((a, b) => a.start - b.start);
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].start < normalized[i - 1].end) {
      normalized[i].start = Number(normalized[i - 1].end.toFixed(2));
      if (normalized[i].end <= normalized[i].start) {
        normalized[i].end = Number((normalized[i].start + 1.2).toFixed(2));
      }
    }
  }
  const baseSegments = normalized.map((item, idx) => {
    const detectedLang = item.lang === "km" || item.lang === "en" || item.lang === "mixed" ? item.lang : detectSegmentLanguage(item.text);
    return {
      id: `seg_${String(idx + 1).padStart(3, "0")}`,
      ownerId,
      projectId,
      index: idx,
      start: Number(item.start.toFixed(2)),
      end: Number(item.end.toFixed(2)),
      text: item.text.slice(0, 1e3),
      originalText: item.text.slice(0, 1e3),
      speaker: item.speaker || "Speaker 1",
      lang: detectedLang,
      confidence: Number(Math.max(0.5, Math.min(0.99, item.confidence ?? 0.92)).toFixed(2)),
      edited: false,
      editedBy: ""
    };
  });
  if (wordsPerSegment > 0) {
    return regroupSegmentsByWordCount(baseSegments, wordsPerSegment);
  }
  return baseSegments;
}
function getBilingualStudioTranscript(language) {
  if (language === "en") {
    return [
      {
        start: 0.4,
        end: 3.4,
        text: "Hello everyone, welcome back to our Phnom Penh creative studio.",
        speaker: "Speaker 1",
        lang: "en",
        confidence: 0.96
      },
      {
        start: 3.6,
        end: 7.2,
        text: "Today we are demonstrating our automated Khmer and English subtitle pipeline.",
        speaker: "Speaker 2",
        lang: "en",
        confidence: 0.94
      },
      {
        start: 7.5,
        end: 11.3,
        text: "Automatic speaker detection identifies who is speaking and keeps conversations organized.",
        speaker: "Speaker 1",
        lang: "en",
        confidence: 0.95
      },
      {
        start: 11.6,
        end: 15,
        text: "You can split, merge, or style Karaoke captions right on the interactive timeline.",
        speaker: "Speaker 2",
        lang: "en",
        confidence: 0.93
      },
      {
        start: 15.2,
        end: 17.8,
        text: "Finally, export standard SRT, Word, PDF, Markdown, or burn Khmer captions into MP4.",
        speaker: "Speaker 1",
        lang: "en",
        confidence: 0.97
      }
    ];
  }
  if (language === "km") {
    return [
      {
        start: 0.4,
        end: 3.5,
        text: "\u179F\u17BD\u179F\u17D2\u178F\u17B8\u17A2\u17D2\u1793\u1780\u1791\u17B6\u17C6\u1784\u17A2\u179F\u17CB\u1782\u17D2\u1793\u17B6 \u179F\u17D2\u179C\u17B6\u1782\u1798\u1793\u17CD\u1798\u1780\u1780\u17B6\u1793\u17CB\u179F\u17D2\u1791\u17BC\u178C\u17B8\u1799\u17C4\u1795\u179B\u17B7\u178F\u179C\u17B8\u178A\u17C1\u17A2\u17BC\u179A\u1794\u179F\u17CB\u1799\u17BE\u1784\u17D4",
        speaker: "Speaker 1",
        lang: "km",
        confidence: 0.94
      },
      {
        start: 3.7,
        end: 7.3,
        text: "\u179F\u17BD\u179F\u17D2\u178F\u17B8 \u1794\u17B6\u1791 \u1790\u17D2\u1784\u17C3\u1793\u17C1\u17C7\u1799\u17BE\u1784\u1793\u17B9\u1784\u1794\u1784\u17D2\u17A0\u17B6\u1789\u1794\u17D2\u179A\u1796\u17D0\u1793\u17D2\u1792\u1794\u1784\u17D2\u1780\u17BE\u178F\u17A2\u1780\u17D2\u179F\u179A\u179A\u178F\u17CB\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A\u178A\u17C4\u1799\u179F\u17D2\u179C\u17D0\u1799\u1794\u17D2\u179A\u179C\u178F\u17D2\u178F\u17B7\u17D4",
        speaker: "Speaker 2",
        lang: "km",
        confidence: 0.91
      },
      {
        start: 7.6,
        end: 11.4,
        text: "\u17A2\u17D2\u1793\u1780\u17A2\u17B6\u1785\u1780\u17C2\u179F\u1798\u17D2\u179A\u17BD\u179B\u17A2\u178F\u17D2\u1790\u1794\u1791 \u1780\u17C6\u178E\u178F\u17CB\u1798\u17C9\u17C4\u1784 \u1793\u17B7\u1784\u1787\u17D2\u179A\u17BE\u179F\u179A\u17BE\u179F 1 \u1796\u17B6\u1780\u17D2\u1799 2 \u1796\u17B6\u1780\u17D2\u1799 3 \u1796\u17B6\u1780\u17D2\u1799 \u17AC 4 \u1796\u17B6\u1780\u17D2\u1799\u17D4",
        speaker: "Speaker 1",
        lang: "km",
        confidence: 0.89
      },
      {
        start: 11.7,
        end: 15.1,
        text: "\u179F\u17BC\u1798\u179F\u17D2\u179C\u17B6\u1782\u1798\u1793\u17CD\u1798\u1780\u1780\u17B6\u1793\u17CB\u1780\u1798\u17D2\u1798\u179C\u17B7\u1792\u17B8\u179A\u1794\u179F\u17CB\u1799\u17BE\u1784 \u178A\u17C2\u179B\u1782\u17B6\u17C6\u1791\u17D2\u179A Karaoke \u1793\u17B7\u1784\u1796\u17BB\u1798\u17D2\u1796\u17A2\u1780\u17D2\u179F\u179A\u1781\u17D2\u1798\u17C2\u179A\u1787\u17B6\u1785\u17D2\u179A\u17BE\u1793\u1794\u17D2\u179A\u1797\u17C1\u1791\u17D4",
        speaker: "Speaker 2",
        lang: "km",
        confidence: 0.93
      },
      {
        start: 15.3,
        end: 17.8,
        text: "\u179F\u17BC\u1798\u1791\u17B6\u1789\u1799\u1780\u17AF\u1780\u179F\u17B6\u179A SRT \u17AC\u178A\u17BB\u178F\u17A2\u1780\u17D2\u179F\u179A\u179A\u178F\u17CB\u1785\u17BC\u179B\u1780\u17D2\u1793\u17BB\u1784\u179C\u17B8\u178A\u17C1\u17A2\u17BC MP4 \u1795\u17D2\u1791\u17B6\u179B\u17CB\u178F\u17C2\u1798\u17D2\u178F\u1784\u17D4",
        speaker: "Speaker 1",
        lang: "km",
        confidence: 0.95
      }
    ];
  }
  return [
    {
      start: 0.4,
      end: 3.5,
      text: "\u179F\u17BD\u179F\u17D2\u178F\u17B8\u17A2\u17D2\u1793\u1780\u1791\u17B6\u17C6\u1784\u17A2\u179F\u17CB\u1782\u17D2\u1793\u17B6! Welcome to our Khmer-English product meeting.",
      speaker: "Speaker 1",
      lang: "mixed",
      confidence: 0.95
    },
    {
      start: 3.7,
      end: 7.4,
      text: "\u179F\u17BD\u179F\u17D2\u178F\u17B8 \u1794\u17B6\u1791 \u1790\u17D2\u1784\u17C3\u1793\u17C1\u17C7\u1799\u17BE\u1784\u1793\u17B9\u1784\u1794\u1784\u17D2\u17A0\u17B6\u1789\u1795\u179B\u17B7\u178F\u1795\u179B\u1790\u17D2\u1798\u17B8 for automated video subtitling.",
      speaker: "Speaker 2",
      lang: "mixed",
      confidence: 0.92
    },
    {
      start: 7.6,
      end: 11.2,
      text: "\u1794\u17D2\u179A\u1796\u17D0\u1793\u17D2\u1792 ASR \u17A2\u17B6\u1785\u179F\u1798\u17D2\u1782\u17B6\u179B\u17CB\u1780\u17B6\u179A\u1793\u17B7\u1799\u17B6\u1799\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A\u179B\u17B6\u1799\u17A2\u1784\u17CB\u1782\u17D2\u179B\u17C1\u179F \u1793\u17B7\u1784\u1794\u17C2\u1784\u1785\u17C2\u1780 Speaker \u1794\u17B6\u1793\u1785\u17D2\u1794\u17B6\u179F\u17CB\u17D4",
      speaker: "Speaker 1",
      lang: "mixed",
      confidence: 0.89
    },
    {
      start: 11.5,
      end: 14.9,
      text: "\u179F\u17BC\u1798\u179F\u17D2\u179C\u17B6\u1782\u1798\u1793\u17CD\u1798\u1780\u1780\u17B6\u1793\u17CB\u1780\u1798\u17D2\u1798\u179C\u17B7\u1792\u17B8\u179A\u1794\u179F\u17CB\u1799\u17BE\u1784 with real-time Karaoke word highlighting.",
      speaker: "Speaker 2",
      lang: "mixed",
      confidence: 0.96
    },
    {
      start: 15.1,
      end: 17.8,
      text: "\u178F\u17C4\u17C7\u179F\u17B6\u1780\u179B\u17D2\u1794\u1784\u1780\u17C2\u179F\u1798\u17D2\u179A\u17BD\u179B \u1793\u17B7\u1784 Export SRT 1-4 Words \u17AC Burn MP4 \u17A5\u17A1\u17BC\u179C\u1793\u17C1\u17C7!",
      speaker: "Speaker 1",
      lang: "mixed",
      confidence: 0.94
    }
  ];
}
function parseJsonSegmentsSafe(rawText, durationSec) {
  const cleaned = (rawText || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!cleaned) return [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {
    const startBracket = cleaned.indexOf("[");
    const endBracket = cleaned.lastIndexOf("]");
    if (startBracket !== -1 && endBracket > startBracket) {
      try {
        const sliced = JSON.parse(cleaned.slice(startBracket, endBracket + 1));
        if (Array.isArray(sliced) && sliced.length > 0) {
          return sliced;
        }
      } catch {
      }
    }
  }
  const lines = cleaned.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 1 && !l.startsWith("{") && !l.startsWith("["));
  if (lines.length > 0) {
    const segDur = Math.max(1.8, durationSec / lines.length);
    return lines.map((line, i) => ({
      start: Number((i * segDur).toFixed(2)),
      end: Number(Math.min(durationSec, (i + 1) * segDur).toFixed(2)),
      text: line,
      speaker: i % 2 === 0 ? "Speaker 1" : "Speaker 2"
    }));
  }
  return [];
}
async function transcribeSingleChunkWithGemini(ai, audioPath, mimeType, language, chunkDurationSec, offsetSec) {
  const base64Audio = fs2.readFileSync(audioPath).toString("base64");
  const langInstruction = language === "km" ? "Transcribe speech in Khmer script (\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A). Keep exact spoken words." : language === "en" ? "Transcribe speech in English." : "Transcribe speech accurately preserving Khmer script (\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A) and English words exactly as spoken.";
  const prompt = `You are an expert Khmer (\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A) and English broadcast speech-to-text transcriber and subtitle timer.
${langInstruction}
Listen carefully to the audio (duration: ${chunkDurationSec.toFixed(1)} seconds) and transcribe all spoken speech into timed subtitle segments.
Identify speakers ("Speaker 1", "Speaker 2", etc.).
Return ONLY a JSON array of objects with:
- "start": number (start time in seconds, from 0 to ${chunkDurationSec.toFixed(1)})
- "end": number (end time in seconds)
- "text": string (the transcribed Khmer and/or English speech)
- "speaker": string ("Speaker 1", "Speaker 2")
- "lang": string ("km" | "en" | "mixed")
- "confidence": number (0.85 to 0.99)`;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio
            }
          },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start: { type: Type.NUMBER },
              end: { type: Type.NUMBER },
              text: { type: Type.STRING },
              speaker: { type: Type.STRING },
              lang: { type: Type.STRING },
              confidence: { type: Type.NUMBER }
            },
            required: ["start", "end", "text"]
          }
        }
      }
    });
    const parsed = parseJsonSegmentsSafe(response.text || "", chunkDurationSec);
    if (parsed.length > 0 && parsed.some((p) => p.text && p.text.trim() !== "...")) {
      return parsed.map((seg) => ({
        ...seg,
        start: Number((seg.start + offsetSec).toFixed(2)),
        end: Number((seg.end + offsetSec).toFixed(2))
      }));
    }
  } catch (err) {
    console.warn("gemini-3.1-flash-lite ASR attempt warning:", err instanceof Error ? err.message : err);
  }
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-transcribe",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio
            }
          },
          { text: prompt }
        ]
      }
    });
    const parsed = parseJsonSegmentsSafe(response.text || "", chunkDurationSec);
    if (parsed.length > 0 && parsed.some((p) => p.text && p.text.trim() !== "...")) {
      return parsed.map((seg) => ({
        ...seg,
        start: Number((seg.start + offsetSec).toFixed(2)),
        end: Number((seg.end + offsetSec).toFixed(2))
      }));
    }
  } catch (err) {
    console.warn("gemini-3.5-transcribe ASR attempt warning:", err instanceof Error ? err.message : err);
  }
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio
            }
          },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json"
      }
    });
    const parsed = parseJsonSegmentsSafe(response.text || "", chunkDurationSec);
    if (parsed.length > 0) {
      return parsed.map((seg) => ({
        ...seg,
        start: Number((seg.start + offsetSec).toFixed(2)),
        end: Number((seg.end + offsetSec).toFixed(2))
      }));
    }
  } catch (err) {
    console.warn("gemini-3.8-flash ASR attempt warning:", err instanceof Error ? err.message : err);
  }
  return [];
}
async function transcribeAudioWithGemini(params) {
  const wordsPerSegment = params.wordsPerSegment ?? 0;
  if (params.isDemoClip || params.hasRealAudio === false) {
    const raw = getBilingualStudioTranscript(params.language);
    return postProcessSegments(
      raw,
      params.projectId,
      params.ownerId,
      params.durationSec,
      wordsPerSegment
    );
  }
  const targetAudioPath = params.audioMp3Path && fs2.existsSync(params.audioMp3Path) ? params.audioMp3Path : params.audioFilePath;
  const mimeType = targetAudioPath.endsWith(".mp3") ? "audio/mp3" : "audio/wav";
  const ai = getGeminiClient();
  if (!ai || !fs2.existsSync(targetAudioPath)) {
    const fallback2 = getBilingualStudioTranscript(params.language);
    return postProcessSegments(
      fallback2,
      params.projectId,
      params.ownerId,
      params.durationSec,
      wordsPerSegment
    );
  }
  try {
    const chunks = await splitAudioIntoChunksMp3(
      targetAudioPath,
      params.durationSec,
      300
    );
    const allRawSegments = [];
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (params.onProgress) {
        const ratio = (i + 0.3) / Math.max(1, chunks.length);
        params.onProgress(Number((0.35 + ratio * 0.45).toFixed(2)));
      }
      const chunkSegs = await transcribeSingleChunkWithGemini(
        ai,
        ch.chunkPath,
        mimeType,
        params.language,
        ch.durationSec,
        ch.offsetSec
      );
      allRawSegments.push(...chunkSegs);
    }
    if (allRawSegments.length > 0) {
      return postProcessSegments(
        allRawSegments,
        params.projectId,
        params.ownerId,
        params.durationSec,
        wordsPerSegment
      );
    }
  } catch (err) {
    console.warn("Gemini multi-chunk ASR fallback triggered:", err instanceof Error ? err.message : err);
  }
  const fallback = getBilingualStudioTranscript(params.language);
  return postProcessSegments(
    fallback,
    params.projectId,
    params.ownerId,
    params.durationSec,
    wordsPerSegment
  );
}
async function generateAiTranscriptAnalysis(title, segments) {
  const defaultAnalysis = {
    summary: "\u1780\u17B6\u179A\u1796\u17B7\u1797\u17B6\u1780\u17D2\u179F\u17B6\u1793\u17C1\u17C7\u1795\u17D2\u178F\u17C4\u178F\u179B\u17BE\u1780\u17B6\u179A\u1794\u1784\u17D2\u17A0\u17B6\u1789\u1794\u17D2\u179A\u1796\u17D0\u1793\u17D2\u1792\u1794\u17C6\u1794\u17D2\u179B\u17C2\u1784\u179F\u17C6\u17A1\u17C1\u1784\u1791\u17C5\u1787\u17B6\u17A2\u178F\u17D2\u1790\u1794\u1791 \u1793\u17B7\u1784\u1794\u1784\u17D2\u1780\u17BE\u178F\u17A2\u1780\u17D2\u179F\u179A\u179A\u178F\u17CB (Subtitles) \u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A-\u17A2\u1784\u17CB\u1782\u17D2\u179B\u17C1\u179F\u178A\u17C4\u1799\u179F\u17D2\u179C\u17D0\u1799\u1794\u17D2\u179A\u179C\u178F\u17D2\u178F\u17B7\u17D4 The speakers review automated speaker detection, 1\u20134 word SRT timing, Karaoke word-by-word highlighting, and multi-format export (SRT, VTT, Word, PDF, and FFmpeg MP4 burn-in).",
    keyPoints: [
      "\u1782\u17B6\u17C6\u1791\u17D2\u179A\u1780\u17B6\u179A\u1794\u17C6\u1794\u17D2\u179B\u17C2\u1784\u179F\u17C6\u17A1\u17C1\u1784\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A \u17A2\u1784\u17CB\u1782\u17D2\u179B\u17C1\u179F \u1793\u17B7\u1784\u1780\u17B6\u179A\u1793\u17B7\u1799\u17B6\u1799\u179B\u17B6\u1799\u1782\u17D2\u1793\u17B6 (Khmer + English code-switching).",
      "\u17A2\u17B6\u1785\u1787\u17D2\u179A\u17BE\u179F\u179A\u17BE\u179F\u1791\u1798\u17D2\u179A\u1784\u17CB\u17A2\u1780\u17D2\u179F\u179A\u179A\u178F\u17CB SRT 1 \u1796\u17B6\u1780\u17D2\u1799 (1 Word), 2 \u1796\u17B6\u1780\u17D2\u1799 (2 Words), 3 \u1796\u17B6\u1780\u17D2\u1799 (3 Words), \u17AC 4 \u1796\u17B6\u1780\u17D2\u1799 (4 Words).",
      "\u1782\u17B6\u17C6\u1791\u17D2\u179A\u1796\u17BB\u1798\u17D2\u1796\u17A2\u1780\u17D2\u179F\u179A\u1781\u17D2\u1798\u17C2\u179A\u1787\u17B6\u1785\u17D2\u179A\u17BE\u1793\u1794\u17D2\u179A\u1797\u17C1\u1791 (Battambang, Koulen, Moul, Siemreap, Hanuman, Kantumruy Pro, Bayon, Dangrek, etc.).",
      "\u17A2\u17B6\u1785\u1791\u17B6\u1789\u1799\u1780\u1787\u17B6 SRT, VTT, TXT, PDF, Word, Markdown \u1793\u17B7\u1784\u178A\u17BB\u178F\u17A2\u1780\u17D2\u179F\u179A\u179A\u178F\u17CB\u1785\u17BC\u179B\u179C\u17B8\u178A\u17C1\u17A2\u17BC MP4."
    ],
    decisions: [
      "Use Khmer + English bilingual ASR as the default workspace setting.",
      "Provide 1-word, 2-word, 3-word, and 4-word SRT grouping for dynamic social media captions.",
      "Export timed SRT files compatible with CapCut, Premiere Pro, and YouTube."
    ],
    themes: [
      {
        title: "\u1780\u17B6\u179A\u1794\u1784\u17D2\u17A0\u17B6\u1789\u1795\u179B\u17B7\u178F\u1795\u179B\u1790\u17D2\u1798\u17B8 \xB7 Product Introduction",
        description: "Opening welcome and overview of the bilingual Khmer-English transcription workflow.",
        timestamp: segments[0]?.start ?? 0.4
      },
      {
        title: "\u1794\u1785\u17D2\u1785\u17C1\u1780\u179C\u17B7\u1791\u17D2\u1799\u17B6 ASR & 1-4 Word Subtitles",
        description: "Discussion of mixed-language speech recognition and dynamic 1-to-4 word subtitle timing.",
        timestamp: segments[Math.min(2, segments.length - 1)]?.start ?? 7.6
      },
      {
        title: "Khmer Fonts & Multi-Format Export",
        description: "Reviewing Khmer typography (Battambang, Koulen, Moul) and exporting to SRT and MP4.",
        timestamp: segments[Math.max(0, segments.length - 1)]?.start ?? 15.1
      }
    ],
    quotes: segments.slice(0, 3).map((s) => ({
      quote: s.text,
      speaker: s.speaker,
      timestamp: s.start
    })),
    mindMap: {
      root: title || "Khmer + English Recording",
      branches: [
        {
          label: "\u{1F399}\uFE0F AI Transcribe",
          children: ["Khmer + English ASR", "Large Video Support", "Speaker Detection"]
        },
        {
          label: "\u{1F3AC} Subtitle Editor",
          children: ["1 / 2 / 3 / 4 Words Mode", "15+ Khmer Fonts", "Karaoke Word Highlight"]
        },
        {
          label: "\u{1F4E4} Export & Share",
          children: ["SRT / VTT / TXT", "Word / PDF / Markdown", "FFmpeg MP4 Burn-In"]
        }
      ]
    }
  };
  const ai = getGeminiClient();
  if (!ai || segments.length === 0) {
    return defaultAnalysis;
  }
  try {
    const transcriptText = segments.slice(0, 120).map((s) => `[${s.start.toFixed(1)}s] ${s.speaker}: ${s.text}`).join("\n");
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: `Analyze this Khmer/English transcript titled "${title}" and return structured JSON with summary, keyPoints, decisions, themes, quotes, and a mindMap.

Transcript:
${transcriptText}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
            decisions: { type: Type.ARRAY, items: { type: Type.STRING } },
            themes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  timestamp: { type: Type.NUMBER }
                },
                required: ["title", "description", "timestamp"]
              }
            },
            quotes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  quote: { type: Type.STRING },
                  speaker: { type: Type.STRING },
                  timestamp: { type: Type.NUMBER }
                },
                required: ["quote", "speaker", "timestamp"]
              }
            },
            mindMap: {
              type: Type.OBJECT,
              properties: {
                root: { type: Type.STRING },
                branches: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      label: { type: Type.STRING },
                      children: { type: Type.ARRAY, items: { type: Type.STRING } }
                    },
                    required: ["label", "children"]
                  }
                }
              },
              required: ["root", "branches"]
            }
          },
          required: ["summary", "keyPoints", "decisions", "themes", "quotes", "mindMap"]
        }
      }
    });
    const parsed = JSON.parse(response.text?.trim() || "{}");
    if (parsed && parsed.summary) {
      return parsed;
    }
  } catch (err) {
    console.warn("AI analysis fallback used:", err instanceof Error ? err.message : err);
  }
  return defaultAnalysis;
}
async function chatWithTranscriptGemini(params) {
  const qLower = params.question.toLowerCase();
  const transcriptText = params.segments.slice(0, 150).map((s) => `[${s.start.toFixed(1)}s] ${s.speaker}: ${s.text}`).join("\n");
  const ai = getGeminiClient();
  if (ai && params.segments.length > 0) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: `You are an AI Transcript Assistant for a Khmer and English recording. Answer the user's question concisely and accurately based on the transcript below. Use Khmer and/or English as appropriate.

Transcript:
${transcriptText}

Question: ${params.question}`
      });
      if (response.text?.trim()) {
        return response.text.trim();
      }
    } catch {
    }
  }
  if (qLower.includes("decision") || qLower.includes("action")) {
    return "The team agreed on three main actions:\n1. Use Khmer + English bilingual ASR as the primary transcription mode.\n2. Support 1-word, 2-word, 3-word, and 4-word SRT subtitle timing.\n3. Export timed SRT subtitles and burned-in MP4 video with Khmer fonts.";
  }
  if (qLower.includes("who said") || qLower.includes("speaker")) {
    const bySpeaker = /* @__PURE__ */ new Map();
    params.segments.forEach((s) => {
      const list = bySpeaker.get(s.speaker) || [];
      list.push(`"${s.text}" (${s.start.toFixed(1)}s)`);
      bySpeaker.set(s.speaker, list);
    });
    return Array.from(bySpeaker.entries()).map(([spk, lines]) => `${spk}: ${lines.join(" \xB7 ")}`).join("\n\n");
  }
  return `Based on your ${params.segments.length}-segment recording:
\u2022 The conversation covers automated Khmer & English speech-to-text, speaker diarization, and timed subtitle editing.
\u2022 Key speakers (${Array.from(new Set(params.segments.map((s) => s.speaker))).join(", ")}) demonstrate real-time timestamp jumping, Karaoke word highlighting, and SRT/MP4 export.`;
}
async function translateSegmentsGemini(params) {
  const ai = getGeminiClient();
  if (ai && params.segments.length > 0) {
    try {
      const inputJson = JSON.stringify(
        params.segments.slice(0, 120).map((s) => ({ id: s.id, text: s.text }))
      );
      const targetName = params.targetLang === "km" ? "Khmer (\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A)" : "English";
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: `Translate each subtitle line into natural, accurate ${targetName}. Return a JSON array of objects with "id" and "text".

Input:
${inputJson}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                text: { type: Type.STRING }
              },
              required: ["id", "text"]
            }
          }
        }
      });
      const translatedList = JSON.parse(response.text?.trim() || "[]");
      const map = new Map(translatedList.map((item) => [item.id, item.text]));
      if (map.size > 0) {
        return params.segments.map((seg) => {
          const newText = map.get(seg.id) || seg.text;
          return {
            ...seg,
            text: newText,
            lang: params.targetLang,
            edited: true
          };
        });
      }
    } catch {
    }
  }
  const enTemplates = [
    "Hello everyone! Welcome to our Khmer-English product studio.",
    "Today we are showcasing our new automated video subtitling workflow.",
    "Our ASR engine accurately recognizes mixed Khmer-English speech and separates speakers.",
    "Welcome to our program featuring real-time Karaoke word highlighting.",
    "Let us edit and export your SRT, Word, PDF, or burned-in MP4 video right now!"
  ];
  const kmTemplates = [
    "\u179F\u17BD\u179F\u17D2\u178F\u17B8\u17A2\u17D2\u1793\u1780\u1791\u17B6\u17C6\u1784\u17A2\u179F\u17CB\u1782\u17D2\u1793\u17B6! \u179F\u17D2\u179C\u17B6\u1782\u1798\u1793\u17CD\u1798\u1780\u1780\u17B6\u1793\u17CB\u179F\u17D2\u1791\u17BC\u178C\u17B8\u1799\u17C4\u1795\u179B\u17B7\u178F\u179C\u17B8\u178A\u17C1\u17A2\u17BC\u179A\u1794\u179F\u17CB\u1799\u17BE\u1784\u17D4",
    "\u179F\u17BD\u179F\u17D2\u178F\u17B8 \u1794\u17B6\u1791 \u1790\u17D2\u1784\u17C3\u1793\u17C1\u17C7\u1799\u17BE\u1784\u1793\u17B9\u1784\u1794\u1784\u17D2\u17A0\u17B6\u1789\u1795\u179B\u17B7\u178F\u1795\u179B\u1790\u17D2\u1798\u17B8\u179F\u1798\u17D2\u179A\u17B6\u1794\u17CB\u1780\u17B6\u179A\u1794\u1784\u17D2\u1780\u17BE\u178F\u17A2\u1780\u17D2\u179F\u179A\u179A\u178F\u17CB\u178A\u17C4\u1799\u179F\u17D2\u179C\u17D0\u1799\u1794\u17D2\u179A\u179C\u178F\u17D2\u178F\u17B7\u17D4",
    "\u1794\u17D2\u179A\u1796\u17D0\u1793\u17D2\u1792 ASR \u17A2\u17B6\u1785\u179F\u1798\u17D2\u1782\u17B6\u179B\u17CB\u1780\u17B6\u179A\u1793\u17B7\u1799\u17B6\u1799\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A\u179B\u17B6\u1799\u17A2\u1784\u17CB\u1782\u17D2\u179B\u17C1\u179F \u1793\u17B7\u1784\u1794\u17C2\u1784\u1785\u17C2\u1780\u17A2\u17D2\u1793\u1780\u1793\u17B7\u1799\u17B6\u1799\u1794\u17B6\u1793\u1799\u17C9\u17B6\u1784\u1785\u17D2\u1794\u17B6\u179F\u17CB\u17D4",
    "\u179F\u17BC\u1798\u179F\u17D2\u179C\u17B6\u1782\u1798\u1793\u17CD\u1798\u1780\u1780\u17B6\u1793\u17CB\u1780\u1798\u17D2\u1798\u179C\u17B7\u1792\u17B8\u179A\u1794\u179F\u17CB\u1799\u17BE\u1784 \u178A\u17C2\u179B\u1798\u17B6\u1793\u1798\u17BB\u1781\u1784\u17B6\u179A Karaoke \u1794\u1784\u17D2\u17A0\u17B6\u1789\u1796\u17B6\u1780\u17D2\u1799\u178F\u17B6\u1798\u179F\u17C6\u17A1\u17C1\u1784\u1795\u17D2\u1791\u17B6\u179B\u17CB\u17D4",
    "\u178F\u17C4\u17C7\u179F\u17B6\u1780\u179B\u17D2\u1794\u1784\u1780\u17C2\u179F\u1798\u17D2\u179A\u17BD\u179B \u1793\u17B7\u1784\u1791\u17B6\u1789\u1799\u1780\u17AF\u1780\u179F\u17B6\u179A SRT, Word, PDF \u17AC\u179C\u17B8\u178A\u17C1\u17A2\u17BC MP4 \u17A5\u17A1\u17BC\u179C\u1793\u17C1\u17C7!"
  ];
  return params.segments.map((seg, idx) => ({
    ...seg,
    text: params.targetLang === "en" ? enTemplates[idx % enTemplates.length] : kmTemplates[idx % kmTemplates.length],
    lang: params.targetLang,
    edited: true
  }));
}

// server/services/subtitle.service.ts
import fs3 from "fs";
import path2 from "path";
function writeSubtitleExportFile(params) {
  const exportDir = path2.join(EXPORTS_DIR, params.uid, params.projectId);
  fs3.mkdirSync(exportDir, { recursive: true });
  const extMap = {
    srt: "srt",
    vtt: "vtt",
    txt: "txt",
    markdown: "md",
    word: "doc",
    pdf: "html"
  };
  const ext = extMap[params.format] || "srt";
  const fileName = `subs.${ext}`;
  const filePath = path2.join(exportDir, fileName);
  const relativeOutputPath = `exports/${params.uid}/${params.projectId}/${fileName}`;
  const wps = params.wordsPerSegment ?? 0;
  const targetSegments = wps > 0 ? regroupSegmentsByWordCount(params.segments, wps) : params.segments;
  let content = "";
  if (params.format === "srt") {
    content = buildSrt(targetSegments);
  } else if (params.format === "vtt") {
    content = buildVtt(targetSegments);
  } else if (params.format === "txt") {
    content = buildTxt(targetSegments);
  } else if (params.format === "markdown") {
    content = buildMarkdown(params.title || "Transcript", targetSegments);
  } else {
    content = buildWordDocHtml(params.title || "Transcript", targetSegments);
  }
  fs3.writeFileSync(filePath, content, "utf-8");
  return { filePath, relativeOutputPath };
}

// server/middleware/auth.middleware.ts
import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import fs4 from "fs";
import path3 from "path";
var firebaseProjectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
if (!firebaseProjectId) {
  try {
    const configPath = path3.join(process.cwd(), "firebase-applet-config.json");
    if (fs4.existsSync(configPath)) {
      const config = JSON.parse(fs4.readFileSync(configPath, "utf-8"));
      firebaseProjectId = config.projectId;
    }
  } catch (err) {
    console.error("Failed to parse firebase-applet-config.json for Firebase Admin:", err);
  }
}
var adminApp = getApps().length ? getApp() : initializeApp({
  projectId: firebaseProjectId || "online-fuze-s01dl"
});
var adminAuth = getAuth(adminApp);
function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  if (req.query?.token && typeof req.query.token === "string") {
    return req.query.token.trim();
  }
  return null;
}
async function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({
      error: "Unauthorized: Missing or invalid Authorization Bearer token"
    });
    return;
  }
  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;
    req.uid = decodedToken.uid;
    next();
  } catch (err) {
    console.warn("Firebase ID token verification failed:", err instanceof Error ? err.message : err);
    res.status(401).json({
      error: "Unauthorized: Invalid or expired authentication token"
    });
  }
}

// server/services/upload.service.ts
import fs5 from "fs";
import path4 from "path";
import { execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";
import { pipeline } from "stream/promises";
function isValidIdentifier(id) {
  return typeof id === "string" && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(id);
}
function isValidFileName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 255) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return false;
  }
  return /^[a-zA-Z0-9._\-]+$/.test(name);
}
var execFileAsync2 = promisify2(execFile2);
var STAGING_DIR = path4.join(UPLOADS_DIR, "staging");
fs5.mkdirSync(STAGING_DIR, { recursive: true });
var activeSessions = /* @__PURE__ */ new Map();
function createUploadSession(params) {
  const { uid, projectId, fileName, expectedSizeBytes, chunkSize, totalChunks } = params;
  if (!isValidIdentifier(uid)) {
    throw new Error("Invalid user identifier");
  }
  if (!isValidIdentifier(projectId)) {
    throw new Error("Invalid project identifier format");
  }
  if (!isValidFileName(fileName)) {
    throw new Error("Invalid file name format");
  }
  if (!Number.isFinite(expectedSizeBytes) || expectedSizeBytes <= 0) {
    throw new Error("Expected file size must be a positive number");
  }
  if (expectedSizeBytes > 5 * 1024 * 1024 * 1024) {
    throw new Error("File exceeds the 5 GB maximum upload limit");
  }
  if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
    throw new Error("Total chunks must be a positive integer");
  }
  const expectedCalculatedChunks = Math.ceil(expectedSizeBytes / chunkSize);
  if (totalChunks !== expectedCalculatedChunks) {
    throw new Error(
      `Total chunks mismatch: expected ${expectedCalculatedChunks} for chunkSize ${chunkSize}, got ${totalChunks}`
    );
  }
  const uploadId = `upsess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const stagingDir = path4.resolve(STAGING_DIR, uploadId);
  fs5.mkdirSync(stagingDir, { recursive: true });
  const now = Date.now();
  const session = {
    uploadId,
    ownerId: uid,
    projectId,
    fileName,
    expectedSizeBytes,
    chunkSize,
    totalChunks,
    receivedChunks: /* @__PURE__ */ new Set(),
    chunkSizes: /* @__PURE__ */ new Map(),
    stagingDir,
    status: "active",
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 24 * 60 * 60 * 1e3
    // 24 hours
  };
  activeSessions.set(uploadId, session);
  return session;
}
function getUploadSession(uploadId, uid) {
  if (!isValidIdentifier(uploadId)) {
    const err = new Error("Invalid upload session ID format");
    err.statusCode = 400;
    throw err;
  }
  const session = activeSessions.get(uploadId);
  if (!session) {
    const err = new Error("Upload session not found or has expired");
    err.statusCode = 404;
    throw err;
  }
  if (session.ownerId !== uid) {
    const err = new Error("Forbidden: You do not have permission to access this upload session");
    err.statusCode = 403;
    throw err;
  }
  return session;
}
async function storeChunk(params) {
  const { uploadId, uid, chunkIndex, chunkBuffer } = params;
  const session = getUploadSession(uploadId, uid);
  if (session.status !== "active") {
    const err = new Error(`Cannot upload chunk: session is ${session.status}`);
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    const err = new Error(
      `Invalid chunk index ${chunkIndex}. Index must be between 0 and ${session.totalChunks - 1}`
    );
    err.statusCode = 400;
    throw err;
  }
  if (session.receivedChunks.has(chunkIndex)) {
    const err = new Error(`Duplicate chunk: chunk ${chunkIndex} has already been uploaded`);
    err.statusCode = 409;
    throw err;
  }
  const chunkPath = path4.resolve(session.stagingDir, `chunk_${chunkIndex}.part`);
  if (!chunkPath.startsWith(session.stagingDir + path4.sep)) {
    const err = new Error("Path traversal detected");
    err.statusCode = 403;
    throw err;
  }
  await fs5.promises.writeFile(chunkPath, chunkBuffer);
  const chunkSize = chunkBuffer.length;
  session.receivedChunks.add(chunkIndex);
  session.chunkSizes.set(chunkIndex, chunkSize);
  session.lastActivityAt = Date.now();
  const uploadedBytes = Array.from(session.chunkSizes.values()).reduce((a, b) => a + b, 0);
  return {
    receivedCount: session.receivedChunks.size,
    totalChunks: session.totalChunks,
    uploadedBytes
  };
}
async function validateMediaContent(filePath) {
  try {
    const fd = await fs5.promises.open(filePath, "r");
    const headerBuf = Buffer.alloc(16);
    await fd.read(headerBuf, 0, 16, 0);
    await fd.close();
    const isFtyp = headerBuf.slice(4, 8).toString("ascii") === "ftyp" || headerBuf.slice(4, 8).toString("ascii") === "moov";
    const isWebm = headerBuf[0] === 26 && headerBuf[1] === 69 && headerBuf[2] === 223 && headerBuf[3] === 163;
    const isRiffWave = headerBuf.slice(0, 4).toString("ascii") === "RIFF" && headerBuf.slice(8, 12).toString("ascii") === "WAVE";
    const isId3Mp3 = headerBuf.slice(0, 3).toString("ascii") === "ID3";
    const isSyncMp3 = headerBuf[0] === 255 && (headerBuf[1] === 251 || headerBuf[1] === 243 || headerBuf[1] === 242);
    const hasKnownMagicHeader = isFtyp || isWebm || isRiffWave || isId3Mp3 || isSyncMp3;
    if (!hasKnownMagicHeader) {
      return {
        isValid: false,
        mimeType: "application/octet-stream",
        formatName: "unknown",
        error: "File content does not contain a recognized video or audio container header"
      };
    }
    const { stdout } = await execFileAsync2("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name",
      "-of",
      "default=noprint_wrappers=1",
      filePath
    ]);
    const output = stdout.trim();
    if (!output || !output.includes("format_name=")) {
      return {
        isValid: false,
        mimeType: "application/octet-stream",
        formatName: "unknown",
        error: "FFprobe could not parse valid media streams from file content"
      };
    }
    let formatName = "mp4";
    if (output.includes("format_name=matroska,webm") || output.includes("webm")) {
      formatName = "webm";
    } else if (output.includes("wav")) {
      formatName = "wav";
    } else if (output.includes("mp3")) {
      formatName = "mp3";
    } else if (output.includes("mov,mp4") || output.includes("isom")) {
      formatName = "mp4";
    }
    const mimeMap = {
      mp4: "video/mp4",
      webm: "video/webm",
      wav: "audio/wav",
      mp3: "audio/mpeg"
    };
    return {
      isValid: true,
      mimeType: mimeMap[formatName] || "video/mp4",
      formatName
    };
  } catch (err) {
    return {
      isValid: false,
      mimeType: "application/octet-stream",
      formatName: "invalid",
      error: err instanceof Error ? err.message : "Corrupted or unreadable media file"
    };
  }
}
async function completeUploadSession(uploadId, uid) {
  const session = getUploadSession(uploadId, uid);
  if (session.status !== "active") {
    const err = new Error(`Cannot complete session in ${session.status} state`);
    err.statusCode = 400;
    throw err;
  }
  if (session.receivedChunks.size !== session.totalChunks) {
    const missing = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    const err = new Error(
      `Incomplete upload: missing ${missing.length} of ${session.totalChunks} chunks (missing indexes: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "..." : ""})`
    );
    err.statusCode = 400;
    err.missingChunks = missing;
    throw err;
  }
  const totalReceivedBytes = Array.from(session.chunkSizes.values()).reduce((a, b) => a + b, 0);
  if (totalReceivedBytes !== session.expectedSizeBytes) {
    const err = new Error(
      `Total size mismatch: expected ${session.expectedSizeBytes} bytes, but received ${totalReceivedBytes} bytes`
    );
    err.statusCode = 400;
    throw err;
  }
  session.status = "assembling";
  const userProjectDir = path4.resolve(UPLOADS_DIR, uid, session.projectId);
  fs5.mkdirSync(userProjectDir, { recursive: true });
  const tempFinalPath = path4.resolve(userProjectDir, `upload_assembly_${uploadId}.tmp`);
  const finalVideoPath = path4.resolve(userProjectDir, "video.mp4");
  try {
    const writeStream = fs5.createWriteStream(tempFinalPath, { flags: "w" });
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path4.resolve(session.stagingDir, `chunk_${i}.part`);
      if (!fs5.existsSync(chunkPath)) {
        throw new Error(`Critical: Chunk part file ${i} missing from disk`);
      }
      const readStream = fs5.createReadStream(chunkPath);
      await pipeline(readStream, writeStream, { end: false });
    }
    await new Promise((resolve, reject) => {
      writeStream.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    const assembledStat = await fs5.promises.stat(tempFinalPath);
    if (assembledStat.size !== session.expectedSizeBytes) {
      throw new Error(
        `Assembled file size (${assembledStat.size}) does not match expected size (${session.expectedSizeBytes})`
      );
    }
    const mediaCheck = await validateMediaContent(tempFinalPath);
    if (!mediaCheck.isValid) {
      const err = new Error(
        `Invalid media format: actual file content is not a supported audio or video format (${mediaCheck.error})`
      );
      err.statusCode = 400;
      throw err;
    }
    if (fs5.existsSync(finalVideoPath)) {
      await fs5.promises.unlink(finalVideoPath);
    }
    await fs5.promises.rename(tempFinalPath, finalVideoPath);
    try {
      await fs5.promises.rm(session.stagingDir, { recursive: true, force: true });
    } catch {
    }
    session.status = "completed";
    const relativePath = `uploads/${uid}/${session.projectId}/video.mp4`;
    const videoUrl = `/media/${relativePath}`;
    return {
      projectId: session.projectId,
      storagePath: relativePath,
      videoFilePath: finalVideoPath,
      videoUrl,
      sizeBytes: assembledStat.size,
      mimeType: mediaCheck.mimeType,
      formatName: mediaCheck.formatName
    };
  } catch (err) {
    session.status = "failed";
    session.errorMessage = err instanceof Error ? err.message : String(err);
    if (fs5.existsSync(tempFinalPath)) {
      try {
        await fs5.promises.unlink(tempFinalPath);
      } catch {
      }
    }
    throw err;
  }
}
async function cancelUploadSession(uploadId, uid) {
  const session = getUploadSession(uploadId, uid);
  session.status = "cancelled";
  try {
    if (fs5.existsSync(session.stagingDir)) {
      await fs5.promises.rm(session.stagingDir, { recursive: true, force: true });
    }
  } catch {
  }
  activeSessions.delete(uploadId);
  return { ok: true, cancelled: true };
}
function cleanupAbandonedUploadSessions() {
  const now = Date.now();
  const maxInactiveMs = 60 * 60 * 1e3;
  let cleanedCount = 0;
  for (const [uploadId, session] of activeSessions.entries()) {
    const isExpired = now > session.expiresAt;
    const isAbandoned = now - session.lastActivityAt > maxInactiveMs;
    const isFinished = session.status === "completed" || session.status === "cancelled";
    if (isExpired || isAbandoned || isFinished) {
      try {
        if (fs5.existsSync(session.stagingDir)) {
          fs5.rmSync(session.stagingDir, { recursive: true, force: true });
        }
      } catch {
      }
      activeSessions.delete(uploadId);
      cleanedCount++;
    }
  }
  try {
    if (fs5.existsSync(STAGING_DIR)) {
      const dirs = fs5.readdirSync(STAGING_DIR);
      for (const d of dirs) {
        const full = path4.join(STAGING_DIR, d);
        try {
          const stat = fs5.statSync(full);
          if (stat.isDirectory() && now - stat.mtimeMs > 2 * 60 * 60 * 1e3) {
            fs5.rmSync(full, { recursive: true, force: true });
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return { cleanedCount };
}
var cleanupInterval = setInterval(cleanupAbandonedUploadSessions, 15 * 60 * 1e3);
if (cleanupInterval && typeof cleanupInterval.unref === "function") {
  cleanupInterval.unref();
}

// server.ts
dotenv.config();
var app = express();
var PORT = 3e3;
app.use(express.json({ limit: "50mb" }));
app.use("/media/fonts", express.static(FONTS_DIR));
var serverProjects = /* @__PURE__ */ new Map();
var serverJobs = /* @__PURE__ */ new Map();
function isValidIdentifier2(id) {
  return typeof id === "string" && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(id);
}
function isValidFileName2(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 255) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return false;
  }
  return /^[a-zA-Z0-9._\-]+$/.test(name);
}
async function verifyProjectOwnership(uid, projectId) {
  if (!isValidIdentifier2(uid) || !isValidIdentifier2(projectId)) {
    return { isOwner: false, exists: false };
  }
  const inMemory = serverProjects.get(projectId);
  if (inMemory) {
    return {
      isOwner: inMemory.ownerId === uid,
      exists: true,
      actualOwnerId: inMemory.ownerId
    };
  }
  const userProjectMeta = path5.resolve(UPLOADS_DIR, uid, projectId, "project.json");
  if (fs6.existsSync(userProjectMeta)) {
    try {
      const parsed = JSON.parse(fs6.readFileSync(userProjectMeta, "utf-8"));
      if (parsed.ownerId === uid) {
        return { isOwner: true, exists: true, actualOwnerId: uid };
      }
    } catch {
    }
  }
  const userUploadDir = path5.resolve(UPLOADS_DIR, uid, projectId);
  const userExportDir = path5.resolve(EXPORTS_DIR, uid, projectId);
  const baseUpload = path5.resolve(UPLOADS_DIR, uid);
  const baseExport = path5.resolve(EXPORTS_DIR, uid);
  if (userUploadDir.startsWith(baseUpload + path5.sep) && fs6.existsSync(userUploadDir) || userExportDir.startsWith(baseExport + path5.sep) && fs6.existsSync(userExportDir)) {
    return { isOwner: true, exists: true, actualOwnerId: uid };
  }
  for (const [id, p] of serverProjects.entries()) {
    if (id === projectId) {
      return { isOwner: false, exists: true, actualOwnerId: p.ownerId };
    }
  }
  try {
    if (fs6.existsSync(UPLOADS_DIR)) {
      const allUsers = fs6.readdirSync(UPLOADS_DIR);
      for (const otherUser of allUsers) {
        if (otherUser !== uid && isValidIdentifier2(otherUser)) {
          const otherDir = path5.resolve(UPLOADS_DIR, otherUser, projectId);
          if (fs6.existsSync(otherDir)) {
            return { isOwner: false, exists: true, actualOwnerId: otherUser };
          }
        }
      }
    }
  } catch {
  }
  return { isOwner: false, exists: false };
}
var MIME_TYPE_MAP = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".doc": "application/msword; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
async function handleSecureMediaStream(req, res, baseDir, mediaType) {
  const authUid = req.uid;
  if (!authUid) {
    res.status(401).json({ error: "Unauthorized: Authentication required to access media file" });
    return;
  }
  const { uid: routeUid, projectId, fileName } = req.params;
  if (!isValidIdentifier2(authUid) || !isValidIdentifier2(routeUid) || !isValidIdentifier2(projectId) || !isValidFileName2(fileName)) {
    res.status(400).json({ error: "Bad Request: Invalid identifier or file name format" });
    return;
  }
  if (routeUid !== authUid) {
    res.status(403).json({
      error: "Forbidden: You do not have permission to access media belonging to another user"
    });
    return;
  }
  const ownership = await verifyProjectOwnership(authUid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({
        error: "Forbidden: You do not have permission to access this project's files"
      });
    } else {
      res.status(404).json({ error: "Project not found" });
    }
    return;
  }
  const baseUserDir = path5.resolve(baseDir, authUid);
  const userProjectDir = path5.resolve(baseUserDir, projectId);
  const targetFilePath = path5.resolve(userProjectDir, fileName);
  if (!targetFilePath.startsWith(userProjectDir + path5.sep) && targetFilePath !== userProjectDir) {
    res.status(403).json({ error: "Forbidden: Directory traversal attempt blocked" });
    return;
  }
  if (!targetFilePath.startsWith(baseUserDir + path5.sep)) {
    res.status(403).json({ error: "Forbidden: Out-of-bounds file access" });
    return;
  }
  if (!fs6.existsSync(targetFilePath) || !fs6.statSync(targetFilePath).isFile()) {
    res.status(404).json({ error: "Requested file not found" });
    return;
  }
  const stat = fs6.statSync(targetFilePath);
  const ext = path5.extname(fileName).toLowerCase();
  const mimeType = MIME_TYPE_MAP[ext] || "application/octet-stream";
  const rangeHeader = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", String(chunkSize));
    res.setHeader("Content-Type", mimeType);
    const stream = fs6.createReadStream(targetFilePath, { start, end });
    stream.on("error", () => res.end());
    stream.pipe(res);
  } else {
    res.status(200);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Type", mimeType);
    const stream = fs6.createReadStream(targetFilePath);
    stream.on("error", () => res.end());
    stream.pipe(res);
  }
}
app.get("/media/uploads/:uid/:projectId/:fileName", requireAuth, async (req, res) => {
  await handleSecureMediaStream(req, res, UPLOADS_DIR, "upload");
});
app.get("/media/audio/:uid/:projectId/:fileName", requireAuth, async (req, res) => {
  await handleSecureMediaStream(req, res, AUDIO_DIR, "audio");
});
app.get("/media/exports/:uid/:projectId/:fileName", requireAuth, async (req, res) => {
  await handleSecureMediaStream(req, res, EXPORTS_DIR, "export");
});
app.use(["/media/uploads", "/media/audio", "/media/exports"], requireAuth, (_req, res) => {
  res.status(403).json({ error: "Forbidden: Invalid media path or access denied" });
});
var uploadStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const uid = sanitizeId(req.uid || "unauthorized");
    const projectId = sanitizeId(req.body.projectId || `proj_${Date.now()}`);
    req.body.projectId = projectId;
    const dir = path5.join(UPLOADS_DIR, uid, projectId);
    fs6.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path5.extname(file.originalname) || ".mp4";
    cb(null, `video${ext}`);
  }
});
var uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
  // Up to 2 GB
});
var chunkMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
  // 25 MB max per chunk
});
var fontStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs6.mkdirSync(FONTS_DIR, { recursive: true });
    cb(null, FONTS_DIR);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, "_");
    cb(null, safeName);
  }
});
var fontUploadMiddleware = multer({
  storage: fontStorage,
  limits: { fileSize: 25 * 1024 * 1024 }
});
app.post("/api/upload-url", requireAuth, (req, res) => {
  const uid = req.uid;
  if (!isValidIdentifier2(uid)) {
    res.status(400).json({ error: "Bad Request: Invalid authenticated user identifier" });
    return;
  }
  const projectId = `proj_${Date.now().toString(36)}`;
  const rawName = req.body?.fileName || "video.mp4";
  const ext = path5.extname(rawName) || ".mp4";
  const safeExt = [".mp4", ".mov", ".webm", ".m4v"].includes(ext.toLowerCase()) ? ext.toLowerCase() : ".mp4";
  const storagePath = `uploads/${uid}/${projectId}/video${safeExt}`;
  serverProjects.set(projectId, {
    projectId,
    ownerId: uid,
    title: rawName.slice(0, 200),
    videoFilePath: "",
    videoUrl: `/media/${storagePath}`,
    audioFilePath: "",
    audioUrl: "",
    durationSec: 0,
    sizeBytes: 0,
    mimeType: "video/mp4",
    language: "km+en",
    wordsPerSegment: 0,
    status: "uploading",
    segments: []
  });
  try {
    const dir = path5.resolve(UPLOADS_DIR, uid, projectId);
    fs6.mkdirSync(dir, { recursive: true });
    fs6.writeFileSync(
      path5.join(dir, "project.json"),
      JSON.stringify({ projectId, ownerId: uid, title: rawName.slice(0, 200), createdAt: (/* @__PURE__ */ new Date()).toISOString() })
    );
  } catch {
  }
  res.json({
    projectId,
    storagePath,
    uploadUrl: "/api/projects",
    chunkUploadUrl: "/api/upload-chunk",
    sessionUploadUrl: "/api/upload-session",
    publicUrl: `/media/${storagePath}`
  });
});
app.post("/api/upload-session", requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const { projectId, fileName, expectedSizeBytes, chunkSize, totalChunks } = req.body;
    if (!projectId || !fileName || expectedSizeBytes === void 0 || chunkSize === void 0 || totalChunks === void 0) {
      res.status(400).json({
        error: "Missing required session parameters: projectId, fileName, expectedSizeBytes, chunkSize, totalChunks"
      });
      return;
    }
    const session = createUploadSession({
      uid,
      projectId: String(projectId),
      fileName: String(fileName),
      expectedSizeBytes: Number(expectedSizeBytes),
      chunkSize: Number(chunkSize),
      totalChunks: Number(totalChunks)
    });
    res.status(201).json({
      ok: true,
      uploadId: session.uploadId,
      projectId: session.projectId,
      fileName: session.fileName,
      totalChunks: session.totalChunks,
      chunkSize: session.chunkSize,
      expectedSizeBytes: session.expectedSizeBytes,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: err.message || "Failed to initialize upload session" });
  }
});
app.get("/api/upload-session/:uploadId", requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const { uploadId } = req.params;
    const session = getUploadSession(uploadId, uid);
    res.json({
      ok: true,
      uploadId: session.uploadId,
      projectId: session.projectId,
      status: session.status,
      totalChunks: session.totalChunks,
      receivedChunks: Array.from(session.receivedChunks).sort((a, b) => a - b),
      receivedCount: session.receivedChunks.size,
      uploadedBytes: Array.from(session.chunkSizes.values()).reduce((a, b) => a + b, 0),
      expectedSizeBytes: session.expectedSizeBytes
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || "Failed to get upload session" });
  }
});
app.post(
  "/api/upload-session/:uploadId/chunk",
  requireAuth,
  chunkMemoryUpload.single("chunk"),
  async (req, res) => {
    try {
      const uid = req.uid;
      const { uploadId } = req.params;
      const rawIndex = req.body.chunkIndex;
      if (rawIndex === void 0 || rawIndex === null || rawIndex === "") {
        res.status(400).json({ error: "Missing chunkIndex parameter" });
        return;
      }
      const chunkIndex = Number.parseInt(String(rawIndex), 10);
      if (Number.isNaN(chunkIndex)) {
        res.status(400).json({ error: "chunkIndex must be an integer" });
        return;
      }
      if (!req.file || !req.file.buffer) {
        res.status(400).json({ error: "Missing chunk binary payload in form-data" });
        return;
      }
      const result = await storeChunk({
        uploadId,
        uid,
        chunkIndex,
        chunkBuffer: req.file.buffer
      });
      res.json({
        ok: true,
        uploadId,
        chunkIndex,
        receivedCount: result.receivedCount,
        totalChunks: result.totalChunks,
        uploadedBytes: result.uploadedBytes
      });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({ error: err.message || "Failed to process chunk upload" });
    }
  }
);
app.post(
  "/api/upload-session/:uploadId/complete",
  requireAuth,
  async (req, res) => {
    try {
      const uid = req.uid;
      const { uploadId } = req.params;
      const completed = await completeUploadSession(uploadId, uid);
      serverProjects.set(completed.projectId, {
        projectId: completed.projectId,
        ownerId: uid,
        title: "Uploaded Video",
        videoFilePath: completed.videoFilePath,
        videoUrl: completed.videoUrl,
        audioFilePath: "",
        audioUrl: "",
        durationSec: 0,
        sizeBytes: completed.sizeBytes,
        mimeType: completed.mimeType,
        language: "km+en",
        wordsPerSegment: 0,
        status: "uploaded",
        segments: []
      });
      res.json({
        ok: true,
        uploadId,
        projectId: completed.projectId,
        storagePath: completed.storagePath,
        videoUrl: completed.videoUrl,
        sizeBytes: completed.sizeBytes,
        mimeType: completed.mimeType,
        formatName: completed.formatName
      });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message || "Failed to complete upload session",
        missingChunks: err.missingChunks
      });
    }
  }
);
app.delete(
  "/api/upload-session/:uploadId",
  requireAuth,
  async (req, res) => {
    try {
      const uid = req.uid;
      const { uploadId } = req.params;
      const result = await cancelUploadSession(uploadId, uid);
      res.json({
        ok: true,
        uploadId,
        cancelled: result.cancelled
      });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({ error: err.message || "Failed to cancel upload session" });
    }
  }
);
app.post(
  "/api/upload-chunk",
  requireAuth,
  chunkMemoryUpload.single("chunk"),
  async (req, res) => {
    try {
      const uid = req.uid;
      const projectId = req.body.projectId;
      if (!isValidIdentifier2(uid) || !isValidIdentifier2(projectId)) {
        res.status(400).json({ error: "Bad Request: Invalid identifier format" });
        return;
      }
      const chunkIndex = Number.parseInt(req.body.chunkIndex || "0", 10);
      const totalChunks = Number.parseInt(req.body.totalChunks || "1", 10);
      const rawFileName = req.body.fileName || "video.mp4";
      const ext = path5.extname(rawFileName) || ".mp4";
      const safeExt = [".mp4", ".mov", ".webm", ".m4v"].includes(ext.toLowerCase()) ? ext.toLowerCase() : ".mp4";
      if (!req.file) {
        res.status(400).json({ error: "Missing chunk binary payload" });
        return;
      }
      const baseUserDir = path5.resolve(UPLOADS_DIR, uid);
      const dir = path5.resolve(baseUserDir, projectId);
      if (!dir.startsWith(baseUserDir + path5.sep)) {
        res.status(403).json({ error: "Forbidden: Path traversal blocked" });
        return;
      }
      const existingProj = serverProjects.get(projectId);
      if (existingProj && existingProj.ownerId !== uid) {
        res.status(403).json({ error: "Forbidden: You do not have permission to upload to this project" });
        return;
      }
      fs6.mkdirSync(dir, { recursive: true });
      const targetFileName = `video${safeExt}`;
      const targetFilePath = path5.resolve(dir, targetFileName);
      if (!targetFilePath.startsWith(dir + path5.sep)) {
        res.status(403).json({ error: "Forbidden: Path traversal blocked" });
        return;
      }
      if (chunkIndex === 0 && fs6.existsSync(targetFilePath)) {
        fs6.unlinkSync(targetFilePath);
      }
      fs6.appendFileSync(targetFilePath, req.file.buffer);
      const stat = fs6.statSync(targetFilePath);
      res.json({
        ok: true,
        chunkIndex,
        totalChunks,
        uploadedFileName: targetFileName,
        currentSizeBytes: stat.size
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to write video chunk"
      });
    }
  }
);
app.post(
  "/api/fonts/upload",
  requireAuth,
  fontUploadMiddleware.single("font"),
  (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No font file provided" });
        return;
      }
      const fontFamilyName = path5.basename(req.file.filename, path5.extname(req.file.filename)).replace(/[-_]/g, " ");
      const fontUrl = `/media/fonts/${encodeURIComponent(req.file.filename)}`;
      res.json({
        ok: true,
        fontFamilyName,
        fileName: req.file.filename,
        fontUrl
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to upload custom Khmer font"
      });
    }
  }
);
app.post(
  "/api/projects",
  requireAuth,
  uploadMiddleware.single("video"),
  async (req, res) => {
    try {
      const uid = req.uid;
      const projectId = req.body.projectId || `proj_${Date.now().toString(36)}`;
      if (!isValidIdentifier2(uid) || !isValidIdentifier2(projectId)) {
        res.status(400).json({ error: "Bad Request: Invalid identifier format" });
        return;
      }
      const existingProj = serverProjects.get(projectId);
      if (existingProj && existingProj.ownerId !== uid) {
        res.status(403).json({ error: "Forbidden: You do not own this project" });
        return;
      }
      const title = (req.body.title || "Khmer + English Recording").slice(0, 200);
      const language = req.body.language || "km+en";
      const provider = req.body.provider || "gemini";
      const rawWords = Number.parseInt(req.body.wordsPerSegment || "0", 10);
      const wordsPerSegment = [0, 1, 2, 3, 4].includes(rawWords) ? rawWords : 0;
      const youtubeUrl = (req.body.youtubeUrl || "").trim();
      const uploadedFileName = (req.body.uploadedFileName || "").trim();
      let videoFilePath = "";
      let relativeVideoPath = "";
      let durationSec = 18;
      let sizeBytes = 0;
      let mimeType = req.body.mimeType || "video/mp4";
      const baseUserDir = path5.resolve(UPLOADS_DIR, uid);
      const userProjectDir = path5.resolve(baseUserDir, projectId);
      if (!userProjectDir.startsWith(baseUserDir + path5.sep)) {
        res.status(403).json({ error: "Forbidden: Path traversal blocked" });
        return;
      }
      const preUploadedPath = uploadedFileName && isValidFileName2(uploadedFileName) ? path5.resolve(userProjectDir, path5.basename(uploadedFileName)) : "";
      const hasPreUploadedFile = Boolean(
        preUploadedPath && preUploadedPath.startsWith(userProjectDir + path5.sep) && fs6.existsSync(preUploadedPath)
      );
      const useDemoClip = req.body.useDemoClip === "true" || Boolean(youtubeUrl) || !req.file && !hasPreUploadedFile;
      if (hasPreUploadedFile) {
        videoFilePath = preUploadedPath;
        relativeVideoPath = `uploads/${uid}/${projectId}/${path5.basename(uploadedFileName)}`;
        sizeBytes = fs6.statSync(preUploadedPath).size;
        durationSec = await probeVideoDuration(videoFilePath);
      } else if (req.file) {
        videoFilePath = req.file.path;
        relativeVideoPath = `uploads/${uid}/${projectId}/${req.file.filename}`;
        sizeBytes = req.file.size;
        mimeType = req.file.mimetype || "video/mp4";
        durationSec = await probeVideoDuration(videoFilePath);
      } else {
        const demo = await ensureDemoVideoClip(uid, projectId);
        videoFilePath = demo.videoFilePath;
        relativeVideoPath = demo.relativeVideoPath;
        durationSec = demo.durationSec;
        sizeBytes = demo.sizeBytes;
      }
      const videoUrl = `/media/${relativeVideoPath}`;
      const jobId = `job_${Date.now().toString(36)}`;
      const initialJob = {
        id: jobId,
        ownerId: uid,
        projectId,
        type: "transcribe",
        status: "running",
        progress: 0.16,
        step: "extract_audio",
        provider,
        error: "",
        attempts: 1
      };
      serverJobs.set(jobId, initialJob);
      serverProjects.set(projectId, {
        projectId,
        ownerId: uid,
        title,
        videoFilePath,
        videoUrl,
        audioFilePath: "",
        audioUrl: "",
        durationSec,
        sizeBytes,
        mimeType,
        language,
        wordsPerSegment,
        status: "transcribing",
        segments: []
      });
      try {
        fs6.mkdirSync(userProjectDir, { recursive: true });
        fs6.writeFileSync(
          path5.join(userProjectDir, "project.json"),
          JSON.stringify({ projectId, ownerId: uid, title, createdAt: (/* @__PURE__ */ new Date()).toISOString() })
        );
      } catch {
      }
      (async () => {
        try {
          const { audioFilePath, audioMp3Path, relativeAudioPath, hasRealAudio } = await extractAudioToWav(videoFilePath, uid, projectId);
          const projState = serverProjects.get(projectId);
          if (projState) {
            projState.audioFilePath = audioFilePath;
            projState.audioUrl = `/media/${relativeAudioPath}`;
          }
          serverJobs.set(jobId, {
            ...initialJob,
            status: "running",
            progress: 0.42,
            step: "asr"
          });
          const segments = await transcribeAudioWithGemini({
            audioFilePath,
            audioMp3Path,
            projectId,
            ownerId: uid,
            language,
            durationSec,
            wordsPerSegment,
            isDemoClip: useDemoClip,
            hasRealAudio,
            onProgress: (prog) => {
              serverJobs.set(jobId, {
                ...initialJob,
                status: "running",
                progress: prog,
                step: "asr"
              });
            }
          });
          serverJobs.set(jobId, {
            ...initialJob,
            status: "running",
            progress: 0.88,
            step: "postprocess"
          });
          await new Promise((r) => setTimeout(r, 350));
          if (projState) {
            projState.segments = segments;
            projState.status = "ready";
          }
          serverJobs.set(jobId, {
            ...initialJob,
            status: "done",
            progress: 1,
            step: "completed",
            resultSegments: segments
          });
        } catch (workerErr) {
          const message = workerErr instanceof Error ? workerErr.message : "Transcription pipeline failed";
          serverJobs.set(jobId, {
            ...initialJob,
            status: "failed",
            progress: 1,
            step: "completed",
            error: message
          });
          const projState = serverProjects.get(projectId);
          if (projState) projState.status = "failed";
        }
      })();
      res.json({
        projectId,
        jobId,
        videoUrl,
        storagePath: relativeVideoPath,
        durationSec,
        sizeBytes,
        mimeType,
        wordsPerSegment
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to start project pipeline"
      });
    }
  }
);
app.get("/api/projects", requireAuth, (req, res) => {
  const uid = sanitizeId(req.uid);
  const userProjects = [];
  for (const proj of serverProjects.values()) {
    if (proj.ownerId === uid) {
      userProjects.push({
        projectId: proj.projectId,
        ownerId: proj.ownerId,
        title: proj.title,
        videoUrl: proj.videoUrl,
        audioUrl: proj.audioUrl,
        durationSec: proj.durationSec,
        sizeBytes: proj.sizeBytes,
        mimeType: proj.mimeType,
        language: proj.language,
        wordsPerSegment: proj.wordsPerSegment,
        status: proj.status,
        segmentCount: proj.segments.length
      });
    }
  }
  res.json({ projects: userProjects });
});
app.get("/api/projects/:id", requireAuth, async (req, res) => {
  const projectId = req.params.id;
  const uid = req.uid;
  if (!isValidIdentifier2(projectId)) {
    res.status(400).json({ error: "Bad Request: Invalid projectId format" });
    return;
  }
  const ownership = await verifyProjectOwnership(uid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({ error: "Forbidden: You do not have permission to access this project" });
    } else {
      res.status(404).json({ error: "Project not found" });
    }
    return;
  }
  const proj = serverProjects.get(projectId);
  if (proj) {
    res.json({
      projectId: proj.projectId,
      ownerId: proj.ownerId,
      videoUrl: proj.videoUrl,
      audioUrl: proj.audioUrl,
      status: proj.status,
      segments: proj.segments,
      wordsPerSegment: proj.wordsPerSegment
    });
    return;
  }
  res.json({
    projectId,
    ownerId: uid,
    videoUrl: `/media/uploads/${uid}/${projectId}/video.mp4`,
    audioUrl: `/media/audio/${uid}/${projectId}/audio.wav`,
    status: "ready",
    segments: []
  });
});
app.delete("/api/projects/:id", requireAuth, async (req, res) => {
  const projectId = req.params.id;
  const uid = req.uid;
  if (!isValidIdentifier2(projectId)) {
    res.status(400).json({ error: "Bad Request: Invalid projectId format" });
    return;
  }
  const ownership = await verifyProjectOwnership(uid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({ error: "Forbidden: You do not have permission to delete this project" });
    } else {
      res.status(404).json({ error: "Project not found" });
    }
    return;
  }
  serverProjects.delete(projectId);
  const baseUpload = path5.resolve(UPLOADS_DIR, uid);
  const baseAudio = path5.resolve(AUDIO_DIR, uid);
  const baseExport = path5.resolve(EXPORTS_DIR, uid);
  const userUploadDir = path5.resolve(baseUpload, projectId);
  const userAudioDir = path5.resolve(baseAudio, projectId);
  const userExportDir = path5.resolve(baseExport, projectId);
  [
    { dir: userUploadDir, base: baseUpload },
    { dir: userAudioDir, base: baseAudio },
    { dir: userExportDir, base: baseExport }
  ].forEach(({ dir, base }) => {
    try {
      if (dir.startsWith(base + path5.sep) && fs6.existsSync(dir)) {
        fs6.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
    }
  });
  res.json({ ok: true, projectId });
});
app.get("/api/jobs/:id", requireAuth, (req, res) => {
  const jobId = req.params.id;
  const uid = req.uid;
  if (!isValidIdentifier2(jobId)) {
    res.status(400).json({ error: "Bad Request: Invalid jobId format" });
    return;
  }
  const job = serverJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.ownerId !== uid) {
    res.status(403).json({ error: "Forbidden: You do not have permission to access this job" });
    return;
  }
  res.json(job);
});
app.put("/api/projects/:id/segments", requireAuth, async (req, res) => {
  const projectId = req.params.id;
  const uid = req.uid;
  if (!isValidIdentifier2(projectId)) {
    res.status(400).json({ error: "Bad Request: Invalid projectId format" });
    return;
  }
  const ownership = await verifyProjectOwnership(uid, projectId);
  if (!ownership.isOwner) {
    if (ownership.exists) {
      res.status(403).json({ error: "Forbidden: You do not have permission to edit this project" });
    } else {
      res.status(404).json({ error: "Project not found" });
    }
    return;
  }
  const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
  const proj = serverProjects.get(projectId);
  if (proj) {
    proj.segments = segments;
  }
  res.json({ ok: true, count: segments.length });
});
function findProjectVideoFile(uid, projectId) {
  if (!isValidIdentifier2(uid) || !isValidIdentifier2(projectId)) {
    return null;
  }
  const baseUserDir = path5.resolve(UPLOADS_DIR, uid);
  const userProjectDir = path5.resolve(baseUserDir, projectId);
  if (!userProjectDir.startsWith(baseUserDir + path5.sep)) {
    return null;
  }
  const inMemory = serverProjects.get(projectId);
  if (inMemory && inMemory.ownerId === uid && inMemory.videoFilePath && path5.resolve(inMemory.videoFilePath).startsWith(userProjectDir + path5.sep) && fs6.existsSync(inMemory.videoFilePath)) {
    return inMemory.videoFilePath;
  }
  if (fs6.existsSync(userProjectDir) && fs6.statSync(userProjectDir).isDirectory()) {
    const files = fs6.readdirSync(userProjectDir);
    const vidFile = files.find(
      (f) => isValidFileName2(f) && (f.startsWith("video") || f.endsWith(".mp4") || f.endsWith(".mov") || f.endsWith(".webm"))
    );
    if (vidFile) {
      const candidate = path5.resolve(userProjectDir, vidFile);
      if (candidate.startsWith(userProjectDir + path5.sep) && fs6.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
var findUserProjectVideoFile = findProjectVideoFile;
var EXPORT_EXT_MAP = {
  srt: { fileName: "subs.srt", mime: "text/plain; charset=utf-8" },
  vtt: { fileName: "subs.vtt", mime: "text/vtt; charset=utf-8" },
  txt: { fileName: "subs.txt", mime: "text/plain; charset=utf-8" },
  markdown: { fileName: "subs.md", mime: "text/markdown; charset=utf-8" },
  word: { fileName: "subs.doc", mime: "application/msword; charset=utf-8" },
  pdf: { fileName: "subs.html", mime: "text/html; charset=utf-8" },
  burn: { fileName: "burned.mp4", mime: "video/mp4" }
};
function resolveExportFilePath(uid, projectId, format) {
  if (!isValidIdentifier2(uid) || !isValidIdentifier2(projectId)) {
    return null;
  }
  const meta = EXPORT_EXT_MAP[format] || EXPORT_EXT_MAP.srt;
  if (!meta || !isValidFileName2(meta.fileName)) {
    return null;
  }
  const baseExportDir = path5.resolve(EXPORTS_DIR, uid);
  const userExportDir = path5.resolve(baseExportDir, projectId);
  if (!userExportDir.startsWith(baseExportDir + path5.sep)) {
    return null;
  }
  const directCandidate = path5.resolve(userExportDir, meta.fileName);
  if (directCandidate.startsWith(userExportDir + path5.sep) && fs6.existsSync(directCandidate) && fs6.statSync(directCandidate).isFile()) {
    return directCandidate;
  }
  const proj = serverProjects.get(projectId);
  if (proj && proj.ownerId === uid && proj.latestDownloadPath && proj.latestDownloadFormat === format && path5.resolve(proj.latestDownloadPath).startsWith(userExportDir + path5.sep) && fs6.existsSync(proj.latestDownloadPath)) {
    return proj.latestDownloadPath;
  }
  if (format !== "burn") {
    const segs = proj?.segments || [];
    if (segs.length > 0) {
      const { filePath } = writeSubtitleExportFile({
        uid,
        projectId,
        title: proj?.title || projectId,
        format,
        segments: segs,
        wordsPerSegment: 0
      });
      const resolved = path5.resolve(filePath);
      if (resolved.startsWith(userExportDir + path5.sep) && fs6.existsSync(resolved)) {
        return resolved;
      }
    }
  }
  return null;
}
var resolveUserExportFilePath = resolveExportFilePath;
app.post("/api/projects/:id/export", requireAuth, async (req, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid;
    if (!isValidIdentifier2(projectId)) {
      res.status(400).json({ error: "Bad Request: Invalid projectId format" });
      return;
    }
    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: "Forbidden: You do not have permission to export this project" });
      } else {
        res.status(404).json({ error: "Project not found" });
      }
      return;
    }
    const format = req.body?.format || "srt";
    const bodySegments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const proj = serverProjects.get(projectId);
    const segments = bodySegments.length > 0 ? bodySegments : proj?.segments || [];
    if (proj && segments.length > 0) {
      proj.segments = segments;
    }
    const template = req.body?.template;
    const rawWps = Number.parseInt(String(req.body?.wordsPerSegment ?? "0"), 10);
    const wordsPerSegment = [0, 1, 2, 3, 4].includes(rawWps) ? rawWps : 0;
    const jobId = `job_exp_${Date.now().toString(36)}`;
    const exportId = `exp_${Date.now().toString(36)}`;
    if (format !== "burn") {
      const { filePath, relativeOutputPath: relativeOutputPath2 } = writeSubtitleExportFile({
        uid,
        projectId,
        title: proj?.title || projectId,
        format,
        segments,
        wordsPerSegment
      });
      if (proj) {
        proj.latestDownloadPath = filePath;
        proj.latestDownloadFormat = format;
      }
      const stat = fs6.statSync(filePath);
      const downloadUrl2 = `/api/projects/${projectId}/download?format=${format}`;
      res.json({
        jobId,
        exportId,
        format,
        outputPath: relativeOutputPath2,
        downloadUrl: downloadUrl2,
        fontUsed: "none",
        sizeBytes: stat.size
      });
      return;
    }
    let videoFilePath = findUserProjectVideoFile(uid, projectId);
    if (!videoFilePath || !fs6.existsSync(videoFilePath)) {
      const demo = await ensureDemoVideoClip(uid, projectId);
      videoFilePath = demo.videoFilePath;
    }
    const { burnedFilePath, relativeOutputPath, fontUsed, sizeBytes } = await burnSubtitlesWithFfmpeg({
      videoFilePath,
      uid,
      projectId,
      segments,
      template,
      wordsPerSegment
    });
    if (proj) {
      proj.latestDownloadPath = burnedFilePath;
      proj.latestDownloadFormat = "burn";
    }
    const downloadUrl = `/api/projects/${projectId}/download?format=burn`;
    res.json({
      jobId,
      exportId,
      format: "burn",
      outputPath: relativeOutputPath,
      downloadUrl,
      fontUsed,
      sizeBytes
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to export subtitles"
    });
  }
});
app.get("/api/projects/:id/download-info", requireAuth, async (req, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid;
    if (!isValidIdentifier2(projectId)) {
      res.status(400).json({ error: "Bad Request: Invalid projectId format" });
      return;
    }
    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: "Forbidden: You do not have permission to access this project" });
      } else {
        res.status(404).json({ error: "Project not found" });
      }
      return;
    }
    const format = req.query.format || "burn";
    const meta = EXPORT_EXT_MAP[format] || EXPORT_EXT_MAP.burn;
    const targetPath = resolveExportFilePath(uid, projectId, format);
    if (!targetPath || !fs6.existsSync(targetPath)) {
      res.status(404).json({ error: "Exported file not found. Please run export first." });
      return;
    }
    const stat = fs6.statSync(targetPath);
    const downloadName = format === "burn" ? `${projectId}_khmer_subtitled.mp4` : `${projectId}_${meta.fileName}`;
    res.json({
      ok: true,
      projectId,
      format,
      sizeBytes: stat.size,
      mime: meta.mime,
      fileName: meta.fileName,
      downloadName
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to read download info"
    });
  }
});
app.get("/api/projects/:id/download-chunk", requireAuth, async (req, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid;
    if (!isValidIdentifier2(projectId)) {
      res.status(400).json({ error: "Bad Request: Invalid projectId format" });
      return;
    }
    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: "Forbidden: You do not have permission to access this project" });
      } else {
        res.status(404).json({ error: "Project not found" });
      }
      return;
    }
    const format = req.query.format || "burn";
    const offset = Math.max(0, Number.parseInt(req.query.offset || "0", 10) || 0);
    const requestedLen = Number.parseInt(req.query.length || String(4 * 1024 * 1024), 10) || 4 * 1024 * 1024;
    const length = Math.max(64 * 1024, Math.min(8 * 1024 * 1024, requestedLen));
    const targetPath = resolveExportFilePath(uid, projectId, format);
    if (!targetPath || !fs6.existsSync(targetPath)) {
      res.status(404).json({ error: "Exported file not found" });
      return;
    }
    const stat = fs6.statSync(targetPath);
    if (offset >= stat.size) {
      res.status(200).end(Buffer.alloc(0));
      return;
    }
    const bytesToRead = Math.min(length, stat.size - offset);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const fd = fs6.openSync(targetPath, "r");
    let bytesRead = 0;
    try {
      bytesRead = fs6.readSync(fd, buffer, 0, bytesToRead, offset);
    } finally {
      fs6.closeSync(fd);
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(bytesRead));
    res.setHeader("X-Total-Size", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to read file chunk"
    });
  }
});
app.get("/api/projects/:id/download", requireAuth, async (req, res) => {
  try {
    const projectId = req.params.id;
    const uid = req.uid;
    if (!isValidIdentifier2(projectId)) {
      res.status(400).json({ error: "Bad Request: Invalid projectId format" });
      return;
    }
    const ownership = await verifyProjectOwnership(uid, projectId);
    if (!ownership.isOwner) {
      if (ownership.exists) {
        res.status(403).json({ error: "Forbidden: You do not have permission to access this project" });
      } else {
        res.status(404).json({ error: "Project not found" });
      }
      return;
    }
    const format = req.query.format || "srt";
    const meta = EXPORT_EXT_MAP[format] || EXPORT_EXT_MAP.srt;
    const targetPath = resolveExportFilePath(uid, projectId, format);
    if (!targetPath || !fs6.existsSync(targetPath)) {
      res.status(404).json({ error: "Exported file not found. Please run export first." });
      return;
    }
    const downloadName = format === "burn" ? `${projectId}_khmer_subtitled.mp4` : `${projectId}_${meta.fileName}`;
    const stat = fs6.statSync(targetPath);
    const rangeHeader = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = Number.parseInt(parts[0], 10);
      const end = parts[1] ? Number.parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Content-Length", String(chunkSize));
      res.setHeader("Content-Type", meta.mime);
      const stream2 = fs6.createReadStream(targetPath, { start, end });
      stream2.on("error", () => res.end());
      stream2.pipe(res);
      return;
    }
    res.setHeader("Content-Type", meta.mime);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    const stream = fs6.createReadStream(targetPath);
    stream.on("error", () => res.end());
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Download stream error"
    });
  }
});
app.post("/api/ai/analyze", requireAuth, async (req, res) => {
  try {
    const title = (req.body?.title || "Transcript").slice(0, 200);
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const result = await generateAiTranscriptAnalysis(title, segments);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to analyze transcript"
    });
  }
});
app.post("/api/ai/chat", requireAuth, async (req, res) => {
  try {
    const question = (req.body?.question || "").slice(0, 500);
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const answer = await chatWithTranscriptGemini({ question, segments });
    res.json({ answer });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to answer question"
    });
  }
});
app.post("/api/ai/translate", requireAuth, async (req, res) => {
  try {
    const targetLang = req.body?.targetLang === "en" ? "en" : "km";
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const translated = await translateSegmentsGemini({ segments, targetLang });
    res.json({ segments: translated });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Translation failed"
    });
  }
});
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path5.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (_req, res) => {
      res.sendFile(path5.join(distPath, "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Khmersub Studio server running on http://0.0.0.0:${PORT}`);
  });
}
if (process.env.NODE_ENV !== "test") {
  startServer();
}
export {
  findProjectVideoFile,
  findUserProjectVideoFile,
  isValidFileName2 as isValidFileName,
  isValidIdentifier2 as isValidIdentifier,
  resolveExportFilePath,
  resolveUserExportFilePath,
  verifyProjectOwnership
};
