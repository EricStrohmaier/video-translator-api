import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { extractFrames, getVideoDuration } from './frameExtractor.js';
import { detectTextInFrames } from './ocrService.js';
import { translateTexts } from './translationService.js';
import { overlayTranslatedText } from './videoComposer.js';
import dotenv from 'dotenv';
import type { FrameInfo, DetectionFrame, GroupedFrame, TranslationMap } from './types.js';

dotenv.config();

function normalizeCJKSpacing(s: string): string {
  if (!s) return s;
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
  if (!hasCJK) return s;
  return s.replace(/([\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '$1');
}

function groupTextsIntoLines(frame: DetectionFrame): GroupedFrame {
  const items = frame.texts.slice().sort((a, b) => a.y - b.y || a.x - b.x);

  function overlapsY(a: { y: number; height: number }, b: { y: number; height: number }): boolean {
    const top = Math.max(a.y, b.y);
    const bottom = Math.max(top, Math.min(a.y + a.height, b.y + b.height));
    const inter = bottom - top;
    const minH = Math.max(1, Math.min(a.height, b.height));
    return inter / minH >= 0.5;
  }

  const lines = [];
  for (const t of items) {
    let placed = false;
    for (const line of lines) {
      if (overlapsY(t, line.span)) {
        line.items.push(t);
        const y1 = Math.min(line.span.y, t.y);
        const y2 = Math.max(line.span.y + line.span.height, t.y + t.height);
        line.span = { y: y1, height: y2 - y1 };
        placed = true;
        break;
      }
    }
    if (!placed) {
      lines.push({ items: [t], span: { y: t.y, height: t.height } });
    }
  }

  const groups = lines.map((line) => {
    const sorted = line.items.slice().sort((a, b) => a.x - b.x);
    const minX = Math.min(...sorted.map((i) => i.x));
    const minY = Math.min(...sorted.map((i) => i.y));
    const maxX = Math.max(...sorted.map((i) => i.x + i.width));
    const maxY = Math.max(...sorted.map((i) => i.y + i.height));
    const width = maxX - minX;
    const height = maxY - minY;
    const fontSize = Math.round(Math.max(...sorted.map((i) => i.fontSize || Math.round(i.height * 0.8))));
    const original = sorted.map((i) => i.text).join(' ');
    return { text: original, x: minX, y: minY, width, height, fontSize };
  });

  return { framePath: frame.framePath, frameName: frame.frameName, frameNumber: frame.frameNumber, texts: groups };
}

/**
 * Heuristic filter: keep only subtitle-like lines in a grouped frame.
 * Tunable via env:
 *  - SUBTITLE_REGION: bottom | middle | top (default: bottom)
 *  - SUBTITLE_REGION_FRACTION: portion of frame height considered region (default: 0.5)
 *  - SUBTITLE_MIN_CHARS: minimum characters per line (default: 6)
 *  - SUBTITLE_MIN_WORDS: minimum words per line (default: 2)
 *  - SUBTITLE_MIN_ASPECT: min (width/height) for a line (default: 3)
 *  - SUBTITLE_MAX_LINES_PER_FRAME: clamp to N widest lines (default: 2)
 *  - SUBTITLE_REQUIRE_PERSISTENCE: require same text in consecutive frames (default: 1=true)
 */
function filterSubtitleLike(frames: GroupedFrame[]): GroupedFrame[] {
  const filterOff = (process.env.SUBTITLE_FILTER_OFF || '0') === '1';
  if (filterOff) return frames;
  const region = (process.env.SUBTITLE_REGION || 'any').toLowerCase();
  const regionFrac = Math.min(1, Math.max(0.05, Number(process.env.SUBTITLE_REGION_FRACTION || 0.5)));
  const minChars = Math.max(1, Number(process.env.SUBTITLE_MIN_CHARS || 1));
  const minWords = Math.max(1, Number(process.env.SUBTITLE_MIN_WORDS || 1));
  const minAspect = Math.max(1, Number(process.env.SUBTITLE_MIN_ASPECT || 1));
  const maxLinesPerFrame = Math.max(1, Number(process.env.SUBTITLE_MAX_LINES_PER_FRAME || 2));
  const requirePersistence = (process.env.SUBTITLE_REQUIRE_PERSISTENCE || '1') !== '0';

  const prelim = frames.map((frame) => {
    const estFrameHeight = Math.max(1, Math.max(0, ...frame.texts.map((t) => t.y + t.height)) + 10);
    let regionStart = 0;
    let regionEnd = estFrameHeight;
    if (region === 'bottom') {
      regionStart = estFrameHeight * (1 - regionFrac);
      regionEnd = estFrameHeight;
    } else if (region === 'top') {
      regionStart = 0;
      regionEnd = estFrameHeight * regionFrac;
    } else if (region === 'middle') {
      const mid = estFrameHeight / 2;
      const half = (estFrameHeight * regionFrac) / 2;
      regionStart = Math.max(0, mid - half);
      regionEnd = Math.min(estFrameHeight, mid + half);
    } else if (region === 'any') {
      regionStart = 0;
      regionEnd = estFrameHeight;
    }

    const filtered = frame.texts
      .filter((t) => {
        const aspect = (t.width || 1) / Math.max(1, t.height);
        const wordCount = (t.text || '').trim().split(/\s+/).filter(Boolean).length;
        const charCount = (t.text || '').replace(/\s+/g, '').length;
        const lineMidY = t.y + t.height / 2;

        const inRegion = lineMidY >= regionStart && lineMidY <= regionEnd;
        const passesText = charCount >= minChars && wordCount >= minWords;
        const passesAspect = aspect >= minAspect;

        return inRegion && passesText && passesAspect;
      })
      .sort((a, b) => b.width - a.width)
      .slice(0, maxLinesPerFrame);

    return { ...frame, texts: filtered } as GroupedFrame;
  });

  if (!requirePersistence) return prelim;

  const occurrences = new Map<string, number[]>();
  for (const f of prelim) {
    for (const t of f.texts) {
      if (!t.text) continue;
      const arr = occurrences.get(t.text) || [];
      arr.push(f.frameNumber);
      occurrences.set(t.text, arr);
    }
  }

  const keepTexts = new Set<string>();
  occurrences.forEach((framesArr, text) => {
    const sorted = framesArr.slice().sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] + 1) {
        keepTexts.add(text);
        break;
      }
    }
  });

  const finalFrames = prelim.map((f) => ({
    ...f,
    texts: f.texts.filter((t) => keepTexts.has(t.text)),
  }));

  return finalFrames;
}

export interface TranslationResult {
  outputPath: string;
  workDir: string;
  stats: {
    framesProcessed: number;
    textsDetected: number;
    translationsApplied: number;
    processingTime: string;
    outputSize: string;
  };
}

/**
 * Main workflow: Translate text in video
 */
export async function translateVideo(videoPath: string, targetLanguage: string): Promise<TranslationResult> {
  const startTime = Date.now();
  const workDir = path.join(os.tmpdir(), 'vt', `job_${Date.now()}`);

  try {
    console.log('📁 Creating working directory...');
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(`${workDir}/frames`, { recursive: true });

    console.log('🎞️  Step 1: Extracting frames (1 fps)...');
    const frames: FrameInfo[] = await extractFrames(videoPath, `${workDir}/frames`);
    console.log(`   ✅ Extracted ${frames.length} frames`);
    const durationSec = Math.round(await getVideoDuration(videoPath));
    const SKIP_INTRO_SECONDS = Number(process.env.SKIP_INTRO_SECONDS || 0);
    const SKIP_OUTRO_SECONDS = Number(process.env.SKIP_OUTRO_SECONDS || 0);
    const filteredFrames = frames.filter((f) => {
      const t = f.frameNumber - 1;
      if (t < SKIP_INTRO_SECONDS) return false;
      if (SKIP_OUTRO_SECONDS > 0 && t >= Math.max(0, durationSec - SKIP_OUTRO_SECONDS)) return false;
      return true;
    });
    if (filteredFrames.length !== frames.length) {
      console.log(`   ⏭️  Skipping intro/outro seconds (intro=${SKIP_INTRO_SECONDS}, outro=${SKIP_OUTRO_SECONDS}). Using ${filteredFrames.length}/${frames.length} frames.`);
    }

    console.log('🔍 Step 2: Detecting text with OCR...');
    const detections: DetectionFrame[] = await detectTextInFrames(filteredFrames);
    console.log(`   ✅ Detected text in ${detections.filter((d) => d.texts.length > 0).length} frames`);
    if (process.env.DEBUG_OCR === '1') {
      await fs.writeFile(`${workDir}/detections.json`, JSON.stringify(detections, null, 2));
    }

    console.log('📝 Step 3: Grouping OCR words into lines...');
    const groupedFrames: GroupedFrame[] = detections.map(groupTextsIntoLines);
    if (process.env.DEBUG_OCR === '1') {
      await fs.writeFile(`${workDir}/grouped.json`, JSON.stringify(groupedFrames, null, 2));
    }
    console.log('🎯 Step 3.1: Filtering to subtitle-like lines...');
    const subtitleFrames: GroupedFrame[] = filterSubtitleLike(groupedFrames);
    if (process.env.DEBUG_OCR === '1') {
      await fs.writeFile(`${workDir}/subtitle_filtered.json`, JSON.stringify(subtitleFrames, null, 2));
    }
    const uniquePhrases = new Set<string>();
    subtitleFrames.forEach((frame) => frame.texts.forEach((t) => uniquePhrases.add(t.text)));
    console.log(`   ✅ Found ${uniquePhrases.size} subtitle-like unique phrases to translate`);

    console.log(`🌍 Step 4: Translating to ${targetLanguage}...`);
    const translationMap: TranslationMap = await translateTexts(Array.from(uniquePhrases), targetLanguage);
    console.log(`   ✅ Translated ${Object.keys(translationMap).length} texts`);
    if (process.env.DEBUG_TRANSLATION === '1') {
      await fs.writeFile(`${workDir}/translations.json`, JSON.stringify(translationMap, null, 2));
    }

    console.log('🎨 Step 5: Applying translations to frames...');
    const translatedFrames: GroupedFrame[] = subtitleFrames.map((frame) => ({
      ...frame,
      texts: frame.texts.map((textObj) => ({
        ...textObj,
        translatedText: (process.env.NORMALIZE_CJK_SPACING === '0')
          ? (translationMap[textObj.text] || textObj.text)
          : normalizeCJKSpacing(translationMap[textObj.text] || textObj.text),
      })),
    }));

    console.log('🎬 Step 6: Creating video with translated text overlays...');
    const outputPath = `${workDir}/output_translated.mp4`;
    await overlayTranslatedText(videoPath, translatedFrames, outputPath);
    console.log(`   ✅ Video created: ${outputPath}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const outputSize = (await fs.stat(outputPath)).size;

    console.log('');
    console.log('✨ Translation complete!');
    console.log(`   ⏱️  Duration: ${duration}s`);
    console.log(`   📊 Translations applied: ${Object.keys(translationMap).length}`);
    console.log(`   📁 Output: ${outputPath}`);
    console.log(`   💾 Size: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);

    return {
      outputPath,
      workDir,
      stats: {
        framesProcessed: filteredFrames.length,
        textsDetected: uniquePhrases.size,
        translationsApplied: Object.keys(translationMap).length,
        processingTime: `${duration}s`,
        outputSize: `${(outputSize / 1024 / 1024).toFixed(2)} MB`,
      },
    };
  } catch (error) {
    console.error('❌ Error in translation workflow:', (error as Error).message);
    throw error;
  }
}
