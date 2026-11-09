import fs from 'fs';
import path from 'path';
import {
  ExportFormat,
  SubtitleSegment,
  WordsPerSegmentOption,
} from '../../shared/segment.schema';
import {
  buildMarkdown,
  buildSrt,
  buildTxt,
  buildVtt,
  buildWordDocHtml,
  regroupSegmentsByWordCount,
} from '../../src/lib/srt';
import { EXPORTS_DIR } from './media.service';

/**
 * Writes SRT, VTT, TXT, Markdown, Word (.doc), or PDF/HTML subtitle export files
 * with optional 1-word, 2-word, 3-word, or 4-word SRT regrouping.
 */
export function writeSubtitleExportFile(params: {
  uid: string;
  projectId: string;
  title?: string;
  format: Exclude<ExportFormat, 'burn'>;
  segments: SubtitleSegment[];
  wordsPerSegment?: WordsPerSegmentOption;
}): { filePath: string; relativeOutputPath: string } {
  const exportDir = path.join(EXPORTS_DIR, params.uid, params.projectId);
  fs.mkdirSync(exportDir, { recursive: true });

  const extMap: Record<Exclude<ExportFormat, 'burn'>, string> = {
    srt: 'srt',
    vtt: 'vtt',
    txt: 'txt',
    markdown: 'md',
    word: 'doc',
    pdf: 'html',
  };

  const ext = extMap[params.format] || 'srt';
  const fileName = `subs.${ext}`;
  const filePath = path.join(exportDir, fileName);
  const relativeOutputPath = `exports/${params.uid}/${params.projectId}/${fileName}`;

  const wps = params.wordsPerSegment ?? 0;
  const targetSegments =
    wps > 0 ? regroupSegmentsByWordCount(params.segments, wps) : params.segments;

  let content = '';
  if (params.format === 'srt') {
    content = buildSrt(targetSegments);
  } else if (params.format === 'vtt') {
    content = buildVtt(targetSegments);
  } else if (params.format === 'txt') {
    content = buildTxt(targetSegments);
  } else if (params.format === 'markdown') {
    content = buildMarkdown(params.title || 'Transcript', targetSegments);
  } else {
    content = buildWordDocHtml(params.title || 'Transcript', targetSegments);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return { filePath, relativeOutputPath };
}
