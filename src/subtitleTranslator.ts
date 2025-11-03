import { promises as fs } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { extractFrames, getVideoDuration } from './frameExtractor.js';
import { detectTextInFrames } from './ocrService.js';
import { translateTexts } from './translationService.js';
import { overlaySubtitlesBottomCenter, TranslatedFrame, SubtitleOptions, renderSubtitlesPreview } from './subtitleComposer.js';

dotenv.config();

function normalizeCJKSpacing(s: string): string {
  if (!s) return s;
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
  if (!hasCJK) return s;
  return s.replace(/([\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '$1');
}

export async function previewVideoAss(videoPath: string, targetLanguage: string, options?: SubtitleOptions) {
  const absoluteVideoPath = path.resolve(videoPath);
  const workDir = path.resolve(`./temp/job_${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(`${workDir}/frames`, { recursive: true });

  // 1) Extract frames
  const frames = await extractFrames(absoluteVideoPath, `${workDir}/frames`);
  if (!frames.length) throw new Error('No frames extracted');

  // 2) OCR only until first frame with text
  let chosen: any | null = null;
  for (const f of frames) {
    const detections = await detectTextInFrames([f]);
    if (detections[0]?.texts?.length) {
      chosen = detections[0];
      break;
    }
  }
  if (!chosen) throw new Error('No text found to preview');

  // 3) Group words into a single line-level phrase
  const grouped = groupTextsIntoLines(chosen as any);

  // 4) Translate only that frame's texts
  const unique = Array.from(new Set(grouped.texts.map((t) => t.text)));
  const translationMap: Record<string, string> = await translateTexts(unique, targetLanguage);
  const translatedFrame: TranslatedFrame = {
    frameNumber: (chosen as any).frameNumber,
    texts: grouped.texts.map((t) => ({
      ...t,
      translatedText:
        process.env.NORMALIZE_CJK_SPACING === '0'
          ? translationMap[t.text] || t.text
          : normalizeCJKSpacing(translationMap[t.text] || t.text),
    })),
  } as unknown as TranslatedFrame;

  // 5) Render PNG preview
  const previewPath = path.resolve(workDir, 'preview.png');
  await renderSubtitlesPreview(absoluteVideoPath, translatedFrame, previewPath, options || {});
  return { previewPath, workDir, frameNumber: translatedFrame.frameNumber };
}

type OCRBox = { x: number; y: number; width: number; height: number; text: string; fontSize?: number };

type FrameDet = { framePath: string; frameName: string; frameNumber: number; texts: OCRBox[] };

type GroupedFrame = { framePath: string; frameName: string; frameNumber: number; texts: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[] };

function groupTextsIntoLines(frame: FrameDet): GroupedFrame {
  const items = (frame.texts || [])
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);

  function overlapsY(a: OCRBox, b: { y: number; height: number }) {
    const top = Math.max(a.y, b.y);
    const bottom = Math.max(top, Math.min(a.y + a.height, b.y + b.height));
    const inter = bottom - top;
    const minH = Math.max(1, Math.min(a.height, b.height));
    return inter / minH >= 0.5;
  }

  const lines: { items: OCRBox[]; span: { y: number; height: number } }[] = [];
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
    if (!placed) lines.push({ items: [t], span: { y: t.y, height: t.height } });
  }

  const groups = lines.map((line) => {
    const sorted = line.items.slice().sort((a, b) => a.x - b.x);
    const minX = Math.min(...sorted.map((i) => i.x));
    const minY = Math.min(...sorted.map((i) => i.y));
    const maxX = Math.max(...sorted.map((i) => i.x + i.width));
    const maxY = Math.max(...sorted.map((i) => i.y + i.height));
    const width = maxX - minX;
    const height = maxY - minY;
    const fontSize = Math.round(
      Math.max(...sorted.map((i) => i.fontSize || Math.round(i.height * 0.8)))
    );
    const original = sorted.map((i) => i.text).join(' ');
    return { text: original, x: minX, y: minY, width, height, fontSize };
  });

  return { framePath: frame.framePath, frameName: frame.frameName, frameNumber: frame.frameNumber, texts: groups };
}

export async function translateVideoAss(videoPath: string, targetLanguage: string, options?: SubtitleOptions) {
  const startTime = Date.now();
  const absoluteVideoPath = path.resolve(videoPath);
  const workDir = path.resolve(`./temp/job_${Date.now()}`);

  try {
    console.log('📁 Creating working directory...');
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(`${workDir}/frames`, { recursive: true });

    console.log('🎞️  Step 1: Extracting frames (1 fps)...');
    const frames = await extractFrames(absoluteVideoPath, `${workDir}/frames`);
    console.log(`   ✅ Extracted ${frames.length} frames`);
    const durationSec = Math.round(await getVideoDuration(absoluteVideoPath));
    const SKIP_INTRO_SECONDS = Number(process.env.SKIP_INTRO_SECONDS || 0);
    const SKIP_OUTRO_SECONDS = Number(process.env.SKIP_OUTRO_SECONDS || 0);
    const filteredFrames = frames.filter((f: any) => {
      const t = f.frameNumber - 1;
      if (t < SKIP_INTRO_SECONDS) return false;
      if (SKIP_OUTRO_SECONDS > 0 && t >= Math.max(0, durationSec - SKIP_OUTRO_SECONDS)) return false;
      return true;
    });

    console.log('🔍 Step 2: Detecting text with OCR...');
    const detections: FrameDet[] = await detectTextInFrames(filteredFrames);
    console.log(`   ✅ Detected text in ${detections.filter((d) => d.texts.length > 0).length} frames`);

    console.log('📝 Step 3: Grouping OCR words into lines...');
    const groupedFrames: GroupedFrame[] = detections.map(groupTextsIntoLines);

    const uniquePhrases = new Set<string>();
    groupedFrames.forEach((frame) => frame.texts.forEach((t) => uniquePhrases.add(t.text)));

    console.log(`🌍 Step 4: Translating to ${targetLanguage}...`);
    const translationMap: Record<string, string> = await translateTexts(Array.from(uniquePhrases), targetLanguage);
    console.log(`   ✅ Translated ${Object.keys(translationMap).length} texts`);

    console.log('🎨 Step 5: Applying translations to frames...');
    const translatedFrames: TranslatedFrame[] = groupedFrames.map((frame) => ({
      ...frame,
      texts: frame.texts.map((textObj) => ({
        ...textObj,
        translatedText:
          process.env.NORMALIZE_CJK_SPACING === '0'
            ? translationMap[textObj.text] || textObj.text
            : normalizeCJKSpacing(translationMap[textObj.text] || textObj.text),
      })),
    })) as unknown as TranslatedFrame[];

    console.log('🎬 Step 6: Creating video with subtitles (ASS bottom-center)...');
    const outputPath = path.resolve(workDir, 'output_translated.mp4');
    await overlaySubtitlesBottomCenter(absoluteVideoPath, translatedFrames, outputPath, options || {});
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
    console.error('❌ Error in translation workflow:', error);
    throw error;
  }
}
