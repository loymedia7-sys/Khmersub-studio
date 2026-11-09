import {
  AiAnalysisResult,
  SubtitleSegment,
  SegmentLang,
  WordsPerSegmentOption,
} from '../../shared/segment.schema';

/**
 * Formats seconds (e.g. 12.4) to SRT timestamp: 00:00:12,400
 */
export function formatTimestampSrt(seconds: number): string {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor((safeSec % 3600) / 60);
  const secs = Math.floor(safeSec % 60);
  const ms = Math.round((safeSec - Math.floor(safeSec)) * 1000);

  const hh = String(hrs).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const mmm = String(Math.min(999, ms)).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Formats seconds (e.g. 12.4) to WebVTT timestamp: 00:00:12.400
 */
export function formatTimestampVtt(seconds: number): string {
  return formatTimestampSrt(seconds).replace(',', '.');
}

/**
 * Formats seconds for compact editor display: 00:12.40
 */
export function formatTimestampDisplay(seconds: number): string {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safeSec / 60);
  const secs = Math.floor(safeSec % 60);
  const cs = Math.floor((safeSec - Math.floor(safeSec)) * 100);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Formats seconds as HH:MM:SS for speaker transcript cards: 00:00:04
 */
export function formatTimestampHMS(seconds: number): string {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor((safeSec % 3600) / 60);
  const secs = Math.floor(safeSec % 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Formats seconds as MM:SS for quick badges: 00:12
 */
export function formatTimestampShort(seconds: number): string {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safeSec / 60);
  const secs = Math.floor(safeSec % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parses MM:SS.cc or HH:MM:SS,mmm into seconds
 */
export function parseTimeInput(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  const parts = trimmed.split(':');
  if (parts.length === 1) {
    const num = Number.parseFloat(parts[0]);
    return Number.isFinite(num) && num >= 0 ? Number(num.toFixed(2)) : null;
  }
  if (parts.length === 2) {
    const mins = Number.parseInt(parts[0], 10);
    const secs = Number.parseFloat(parts[1]);
    if (Number.isFinite(mins) && Number.isFinite(secs) && mins >= 0 && secs >= 0) {
      return Number((mins * 60 + secs).toFixed(2));
    }
  }
  if (parts.length === 3) {
    const hrs = Number.parseInt(parts[0], 10);
    const mins = Number.parseInt(parts[1], 10);
    const secs = Number.parseFloat(parts[2]);
    if (Number.isFinite(hrs) && Number.isFinite(mins) && Number.isFinite(secs)) {
      return Number((hrs * 3600 + mins * 60 + secs).toFixed(2));
    }
  }
  return null;
}

/**
 * Tokenizes Khmer + English text into accurate individual words using Intl.Segmenter('km')
 * so that 1-word, 2-word, 3-word, and 4-word SRT grouping works for both continuous Khmer script and English.
 */
export function tokenizeKhmerAndEnglishWords(text: string): string[] {
  const cleaned = (text || '').trim();
  if (!cleaned) return [];

  try {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      const segmenter = new Intl.Segmenter('km', { granularity: 'word' });
      const rawSegs = Array.from(segmenter.segment(cleaned));
      const words: string[] = [];
      let hadWhitespaceSinceLastWord = false;

      for (const item of rawSegs) {
        const raw = item.segment;
        const token = raw.trim();
        if (!token) {
          hadWhitespaceSinceLastWord = true;
          continue;
        }
        if (item.isWordLike) {
          // If Intl.Segmenter split a single bare Khmer consonant coda (e.g. "ក" in "ផេក")
          // with no whitespace before it, keep it attached to the previous Khmer syllable
          const isBareKhmerCoda =
            !hadWhitespaceSinceLastWord &&
            words.length > 0 &&
            /[\u1780-\u17FF]/.test(words[words.length - 1]) &&
            /^[\u1780-\u17A2][\u17C9-\u17D1]?$/.test(token);

          if (isBareKhmerCoda) {
            words[words.length - 1] = `${words[words.length - 1]}${token}`;
          } else {
            words.push(token);
          }
          hadWhitespaceSinceLastWord = false;
        } else if (words.length > 0 && /^[។៕៖ៗ៘!?.,;:'")\]}]+$/.test(token)) {
          // Attach trailing Khmer/Latin punctuation to previous word
          words[words.length - 1] = `${words[words.length - 1]}${token}`;
          hadWhitespaceSinceLastWord = false;
        }
      }

      if (words.length > 0) {
        return words;
      }
    }
  } catch {
    // Fallback below
  }

  const spaceSplit = cleaned.split(/\s+/).filter(Boolean);
  if (spaceSplit.length > 1) return spaceSplit;

  // Fallback for continuous Khmer string if Intl.Segmenter is unavailable
  const chunks: string[] = [];
  const step = 6;
  for (let i = 0; i < cleaned.length; i += step) {
    chunks.push(cleaned.slice(i, i + step));
  }
  return chunks;
}

/**
 * Regroups subtitle segments into N words per subtitle (1 word, 2 words, 3 words, or 4 words)
 * with proportionally interpolated timestamps.
 * If wordsPerSegment === 0, returns the input segments unchanged.
 */
export function regroupSegmentsByWordCount(
  segments: SubtitleSegment[],
  wordsPerSegment: WordsPerSegmentOption
): SubtitleSegment[] {
  if (!wordsPerSegment || wordsPerSegment <= 0) {
    return segments.map((s, idx) => ({ ...s, index: idx }));
  }

  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const result: SubtitleSegment[] = [];

  for (const seg of sorted) {
    const words = tokenizeKhmerAndEnglishWords(seg.text);
    if (words.length <= wordsPerSegment) {
      result.push({
        ...seg,
        id: `seg_${String(result.length + 1).padStart(3, '0')}`,
        index: result.length,
      });
      continue;
    }

    const groups: string[] = [];
    for (let i = 0; i < words.length; i += wordsPerSegment) {
      const slice = words.slice(i, i + wordsPerSegment);
      groups.push(slice.join(' '));
    }

    const totalDuration = Math.max(0.2 * groups.length, seg.end - seg.start);
    const totalChars = Math.max(1, groups.reduce((acc, g) => acc + g.length, 0));
    let cursor = seg.start;

    groups.forEach((groupText, gIdx) => {
      const weight = groupText.length / totalChars;
      const chunkDur =
        gIdx === groups.length - 1
          ? Math.max(0.15, seg.end - cursor)
          : Math.max(0.15, totalDuration * weight);
      const start = Number(cursor.toFixed(2));
      const end =
        gIdx === groups.length - 1
          ? Number(Math.max(start + 0.15, seg.end).toFixed(2))
          : Number((start + chunkDur).toFixed(2));
      cursor = end;

      result.push({
        ...seg,
        id: `seg_${String(result.length + 1).padStart(3, '0')}`,
        index: result.length,
        start,
        end,
        text: groupText,
        originalText: groupText,
        lang: detectSegmentLanguage(groupText),
      });
    });
  }

  return result;
}

/**
 * Formats seconds to ASS time format: H:MM:SS.cs (e.g. 0:00:01.25)
 */
export function formatTimestampAss(seconds: number): string {
  const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor((safeSec % 3600) / 60);
  const secs = Math.floor(safeSec % 60);
  const cs = Math.floor((safeSec - Math.floor(safeSec)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Builds standard SRT file content from ordered segments with UTF-8 BOM
 * ensuring zero encoding errors in Windows Notepad, CapCut, Premiere, and VLC.
 */
export function buildSrt(
  segments: SubtitleSegment[],
  wordsPerSegment: WordsPerSegmentOption = 0
): string {
  const targetSegments =
    wordsPerSegment > 0 ? regroupSegmentsByWordCount(segments, wordsPerSegment) : segments;
  const sorted = [...targetSegments].sort((a, b) => a.start - b.start || a.index - b.index);
  return (
    '\uFEFF' +
    sorted
      .map((seg, idx) => {
        const startStr = formatTimestampSrt(seg.start);
        const endStr = formatTimestampSrt(Math.max(seg.start + 0.1, seg.end));
        return `${idx + 1}\n${startStr} --> ${endStr}\n${seg.text.trim()}`;
      })
      .join('\n\n') + '\n'
  );
}

/**
 * Builds WebVTT file content from ordered segments with UTF-8 BOM
 */
export function buildVtt(
  segments: SubtitleSegment[],
  wordsPerSegment: WordsPerSegmentOption = 0
): string {
  const targetSegments =
    wordsPerSegment > 0 ? regroupSegmentsByWordCount(segments, wordsPerSegment) : segments;
  const sorted = [...targetSegments].sort((a, b) => a.start - b.start || a.index - b.index);
  const body = sorted
    .map((seg, idx) => {
      const startStr = formatTimestampVtt(seg.start);
      const endStr = formatTimestampVtt(Math.max(seg.start + 0.1, seg.end));
      return `${idx + 1}\n${startStr} --> ${endStr}\n${seg.text.trim()}`;
    })
    .join('\n\n');
  return `\uFEFFWEBVTT\n\n${body}\n`;
}

/**
 * Builds clean transcript TXT file content with speaker & timecodes
 */
export function buildTxt(segments: SubtitleSegment[]): string {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  return (
    '\uFEFF' +
    sorted
      .map((seg) => `${seg.speaker} (${formatTimestampHMS(seg.start)})\n${seg.text.trim()}\n`)
      .join('\n')
  );
}

/**
 * Builds Markdown (.md) export for writing workflows
 */
export function buildMarkdown(
  title: string,
  segments: SubtitleSegment[],
  analysis?: AiAnalysisResult | null
): string {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const lines: string[] = [`\uFEFF# ${title || 'Transcript & Subtitles'}`, ''];

  if (analysis) {
    lines.push('## AI Summary', '', analysis.summary, '');
    if (analysis.keyPoints.length > 0) {
      lines.push('### Key Points');
      analysis.keyPoints.forEach((pt) => lines.push(`- ${pt}`));
      lines.push('');
    }
    if (analysis.decisions.length > 0) {
      lines.push('### Decisions & Action Items');
      analysis.decisions.forEach((d) => lines.push(`- [ ] ${d}`));
      lines.push('');
    }
  }

  lines.push('## Full Timed Transcript', '');
  sorted.forEach((seg) => {
    lines.push(`**${seg.speaker}** \`[${formatTimestampHMS(seg.start)} → ${formatTimestampHMS(seg.end)}]\`  `);
    lines.push(`${seg.text.trim()}`, '');
  });

  return lines.join('\n');
}

/**
 * Builds an editable Word (.doc) HTML document compatible with Microsoft Word & Google Docs
 * with UTF-8 encoding and Khmer font priority (Noto Sans Khmer, Battambang, Kantumruy Pro)
 */
export function buildWordDocHtml(
  title: string,
  segments: SubtitleSegment[],
  analysis?: AiAnalysisResult | null
): string {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const rows = sorted
    .map(
      (seg) => `
      <div style="margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0;">
        <p style="margin: 0; font-size: 10pt; color: #475569;">
          <strong>${seg.speaker}</strong> &middot; <span>${formatTimestampHMS(seg.start)} - ${formatTimestampHMS(seg.end)}</span>
        </p>
        <p style="margin: 4px 0 0 0; font-size: 13pt; font-family: 'Noto Sans Khmer', 'Battambang', 'Kantumruy Pro', sans-serif; color: #0f172a; line-height: 1.6;">
          ${seg.text.trim()}
        </p>
      </div>`
    )
    .join('\n');

  const summaryBlock = analysis
    ? `<div style="background: #f8fafc; padding: 12px; border: 1px solid #cbd5e1; margin-bottom: 20px;">
        <h2 style="font-size: 13pt; margin-top: 0;">AI Summary</h2>
        <p style="font-size: 11pt; font-family: 'Noto Sans Khmer', 'Battambang', sans-serif;">${analysis.summary}</p>
      </div>`
    : '';

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

/**
 * Converts standard #RRGGBB hex and alpha (0.0=opaque .. 1.0=transparent) to ASS &HAABBGGRR& color format
 */
export function hexToAssColor(hex: string, alphaHex = '00'): string {
  const clean = (hex || '#FFFFFF').replace('#', '').trim();
  if (clean.length !== 6) return `&H${alphaHex}FFFFFF&`;
  const r = clean.slice(0, 2).toUpperCase();
  const g = clean.slice(2, 4).toUpperCase();
  const b = clean.slice(4, 6).toUpperCase();
  return `&H${alphaHex}${b}${g}${r}&`;
}

/**
 * Escapes text for ASS dialogue lines while preserving clean Khmer Unicode clusters
 */
function escapeAssText(text: string): string {
  return (text || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
}

/**
 * Builds Advanced SubStation Alpha (.ass) subtitle file content
 * that preserves the user's exact current CaptionTemplate design:
 * - Exact Khmer/English font family & bold weight
 * - Exact primary text color & karaoke/highlight accent color
 * - Exact outline width, shadow depth, and background box (BorderStyle 1 vs 3)
 * - Exact position (Top / Middle / Bottom / Custom X-Y coordinates) and text alignment
 * - Optional Karaoke (\k), Word-by-Word, and Highlight animations matching the live player
 */
export function buildAss(
  segments: SubtitleSegment[],
  fontName = 'Noto Sans Khmer',
  fontSize = 52,
  primaryColorHex = '#FFFFFF',
  outlineWidth = 3,
  alignment = 2,
  template?: {
    accentColor?: string;
    fontWeight?: string;
    shadow?: 'none' | 'soft' | 'strong';
    background?: 'none' | 'transparent' | 'box' | 'rounded' | 'full_width';
    position?: 'bottom' | 'middle' | 'top' | 'custom';
    customX?: number;
    customY?: number;
    alignment?: 'left' | 'center' | 'right';
    wordAnimation?: 'none' | 'word_by_word' | 'karaoke' | 'highlight' | 'bounce';
    entranceAnimation?: string;
    exitAnimation?: string;
    loopAnimation?: string;
    animationDuration?: number;
    outAnimationDuration?: number;
    animationEasing?: string;
  },
  playResX = 1920,
  playResY = 1080
): string {
  const primaryAss = hexToAssColor(primaryColorHex, '00');
  const secondaryAss = hexToAssColor(template?.accentColor || '#FACC15', '00');

  const bgMode = template?.background || 'rounded';
  const useOpaqueBox = bgMode === 'box' || bgMode === 'rounded' || bgMode === 'full_width';
  const useTransBox = bgMode === 'transparent';
  const borderStyle = useOpaqueBox || useTransBox ? 3 : 1;

  // When BorderStyle=3 (opaque box), OutlineColour controls the box background color & alpha
  const outlineAss =
    borderStyle === 3
      ? useOpaqueBox
        ? '&H40000000&' // 75% opaque black box behind text
        : '&H88000000&' // 47% translucent black box
      : '&H00000000&'; // solid black outline around glyphs

  const backAss = '&H80000000&';
  const isBold =
    !template?.fontWeight ||
    template.fontWeight === 'Bold' ||
    template.fontWeight === 'Extra Bold' ||
    template.fontWeight === 'Medium'
      ? -1
      : 0;

  const effectiveOutline =
    borderStyle === 3
      ? Math.max(8, Math.round(fontSize * 0.22)) // clean padding inside the background box
      : Math.max(0, Math.min(8, outlineWidth));

  const shadowDepth =
    borderStyle === 3
      ? 0
      : template?.shadow === 'none'
        ? 0
        : template?.shadow === 'strong'
          ? 3
          : 1.5;

  // Compute numpad alignment (1..9) from vertical position + horizontal alignment
  const horiz =
    template?.alignment === 'left' ? 1 : template?.alignment === 'right' ? 3 : 2;
  const vertBase =
    template?.position === 'top'
      ? 6
      : template?.position === 'middle'
        ? 3
        : 0;
  const computedAlign = template ? vertBase + horiz : alignment;

  const isVertical = playResY > playResX;
  const marginV =
    template?.position === 'top'
      ? isVertical
        ? 140
        : 75
      : template?.position === 'middle'
        ? 20
        : isVertical
          ? 180
          : 75;
  const marginH = isVertical ? 48 : 60;

  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);

  // Note: Do NOT prepend \uFEFF BOM to .ass files so libass always parses [Script Info] on line 1
  const lines = [
    '[Script Info]',
    '; Generated by Khmersub Studio with HarfBuzz Complex Khmer Shaping',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: KhmerSub,${fontName},${fontSize},${primaryAss},${secondaryAss},${outlineAss},${backAss},${isBold},0,0,0,100,100,0,0,${borderStyle},${effectiveOutline},${shadowDepth},${computedAlign},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  // Optional custom X/Y override tag (in playResX x playResY space)
  let posOverrideTag = '';
  if (template?.position === 'custom') {
    const px = Math.round(((template.customX ?? 50) / 100) * playResX);
    const py = Math.round(((template.customY ?? 85) / 100) * playResY);
    posOverrideTag = `\\pos(${px},${py})`;
  }

  const inMs = Math.max(80, Math.round((template?.animationDuration ?? 0.4) * 1000));
  const outMs =
    template?.exitAnimation && template.exitAnimation !== 'none'
      ? Math.max(80, Math.round((template?.outAnimationDuration ?? 0.3) * 1000))
      : 0;

  let fadeOverrideTag = '';
  const ent = template?.entranceAnimation || 'pop';
  const easing = template?.animationEasing || 'overshoot';

  if (ent === 'fade_in' || ent === 'rise' || ent === 'slide_up' || ent === 'slide_down') {
    fadeOverrideTag += `\\fad(${inMs},${outMs})`;
  } else if (outMs > 0) {
    fadeOverrideTag += `\\fad(0,${outMs})`;
  }

  if (ent === 'pop') {
    if (easing === 'overshoot' || easing === 'elastic' || easing === 'bounce') {
      const midMs = Math.round(inMs * 0.65);
      fadeOverrideTag += `\\fscx70\\fscy70\\t(0,${midMs},\\fscx108\\fscy108)\\t(${midMs},${inMs},\\fscx100\\fscy100)`;
    } else {
      fadeOverrideTag += `\\fscx75\\fscy75\\t(0,${inMs},\\fscx100\\fscy100)`;
    }
  } else if (ent === 'zoom' || ent === 'scale_in') {
    fadeOverrideTag += `\\fscx128\\fscy128\\t(0,${inMs},\\fscx100\\fscy100)`;
  } else if (ent === 'blur') {
    fadeOverrideTag += `\\blur8\\t(0,${inMs},\\blur0)`;
  }

  sorted.forEach((seg) => {
    const startSec = Math.max(0, seg.start);
    const endSec = Math.max(startSec + 0.2, seg.end);
    const startStr = formatTimestampAss(startSec);
    const endStr = formatTimestampAss(endSec);

    const basePrefix =
      posOverrideTag || fadeOverrideTag ? `{${posOverrideTag}${fadeOverrideTag}}` : '';

    const wordAnim =
      template?.entranceAnimation === 'word_by_word'
        ? 'word_by_word'
        : template?.wordAnimation || 'none';
    const rawWords = tokenizeKhmerAndEnglishWords(seg.text);

    if (wordAnim === 'karaoke' && rawWords.length > 1) {
      const totalCs = Math.max(20, Math.round((endSec - startSec) * 100));
      const perWordCs = Math.max(5, Math.floor(totalCs / rawWords.length));
      // In ASS karaoke, PrimaryColour is highlighted state and SecondaryColour is pre-sung state;
      // set initial color to Primary and animate to Accent via \kf
      const karaokeBody = rawWords
        .map((w) => `{\\kf${perWordCs}}${escapeAssText(w)}`)
        .join(' ');
      const karaokeStylePrefix = `{${posOverrideTag}${fadeOverrideTag}\\1c${secondaryAss}\\2c${primaryAss}}`;
      lines.push(
        `Dialogue: 0,${startStr},${endStr},KhmerSub,,0,0,0,,${karaokeStylePrefix}${karaokeBody}`
      );
      return;
    }

    if ((wordAnim === 'highlight' || wordAnim === 'bounce') && rawWords.length > 1) {
      // Emit sub-dialogues for each active word so the spoken word glows in accentColor
      const dur = endSec - startSec;
      const step = dur / rawWords.length;
      rawWords.forEach((_, activeIdx) => {
        const wStart = startSec + activeIdx * step;
        const wEnd =
          activeIdx === rawWords.length - 1 ? endSec : startSec + (activeIdx + 1) * step;
        const renderedSentence = rawWords
          .map((w, idx) => {
            const safeW = escapeAssText(w);
            if (idx === activeIdx) {
              return `{\\1c${secondaryAss}}${safeW}{\\1c${primaryAss}}`;
            }
            return safeW;
          })
          .join(' ');
        lines.push(
          `Dialogue: 0,${formatTimestampAss(wStart)},${formatTimestampAss(wEnd)},KhmerSub,,0,0,0,,${basePrefix}${renderedSentence}`
        );
      });
      return;
    }

    if (wordAnim === 'word_by_word' && rawWords.length > 1) {
      const dur = endSec - startSec;
      const step = dur / rawWords.length;
      rawWords.forEach((_, activeIdx) => {
        const wStart = startSec + activeIdx * step;
        const wEnd =
          activeIdx === rawWords.length - 1 ? endSec : startSec + (activeIdx + 1) * step;
        const visibleWords = rawWords
          .slice(0, activeIdx + 1)
          .map((w, idx) => {
            const safeW = escapeAssText(w);
            return idx === activeIdx
              ? `{\\1c${secondaryAss}}${safeW}{\\1c${primaryAss}}`
              : safeW;
          })
          .join(' ');
        lines.push(
          `Dialogue: 0,${formatTimestampAss(wStart)},${formatTimestampAss(wEnd)},KhmerSub,,0,0,0,,${basePrefix}${visibleWords}`
        );
      });
      return;
    }

    const assText = escapeAssText(seg.text);
    lines.push(`Dialogue: 0,${startStr},${endStr},KhmerSub,,0,0,0,,${basePrefix}${assText}`);
  });

  return lines.join('\n') + '\n';
}

/**
 * Detects whether text contains Khmer Unicode characters (U+1780..U+17FF)
 */
export function detectSegmentLanguage(text: string): SegmentLang {
  const hasKhmer = /[\u1780-\u17FF]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);
  if (hasKhmer && hasLatin) return 'mixed';
  if (hasKhmer) return 'km';
  return 'en';
}

/**
 * Parses an imported SRT string into SubtitleSegment objects
 */
export function parseSrt(srtContent: string, projectId: string, ownerId: string): SubtitleSegment[] {
  const blocks = srtContent
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/);

  const segments: SubtitleSegment[] = [];
  blocks.forEach((block, idx) => {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    const timeLineIdx = lines[0].includes('-->') ? 0 : 1;
    const timeLine = lines[timeLineIdx];
    if (!timeLine || !timeLine.includes('-->')) return;

    const [startRaw, endRaw] = timeLine.split('-->').map((s) => s.trim());
    const start = parseTimeInput(startRaw) ?? idx * 3;
    const end = parseTimeInput(endRaw) ?? start + 2.5;
    const text = lines.slice(timeLineIdx + 1).join(' ').slice(0, 1000) || '...';

    segments.push({
      id: `seg_${String(idx + 1).padStart(3, '0')}`,
      ownerId,
      projectId,
      index: idx,
      start,
      end: Math.max(start + 0.2, end),
      text,
      originalText: text,
      speaker: 'Speaker 1',
      lang: detectSegmentLanguage(text),
      confidence: 0.95,
      edited: false,
      editedBy: '',
    });
  });

  return segments;
}
