import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";
import { extractFrames, getVideoDuration } from "./frameExtractor.js";
import { detectTextInFrames } from "./ocrService.js";
import { translateTexts } from "./translationService.js";
import {
  overlaySubtitlesBottomCenter,
  TranslatedFrame,
  SubtitleOptions,
  renderSubtitlesPreview,
} from "./subtitleComposer.js";

dotenv.config();

function normalizeCJKSpacing(s: string): string {
  if (!s) return s;
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
  if (!hasCJK) return s;
  return s.replace(
    /([\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3400-\u9fff\uf900-\ufaff])/g,
    "$1"
  );
}

export async function previewVideoAss(
  videoPath: string,
  targetLanguage: string,
  options?: SubtitleOptions & { previewAtSeconds?: number }
) {
  const absoluteVideoPath = path.resolve(videoPath);
  const workDir = path.resolve(`./temp/job_${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(`${workDir}/frames`, { recursive: true });

  // 1) Extract frames
  const frames = await extractFrames(absoluteVideoPath, `${workDir}/frames`);
  if (!frames.length) throw new Error("No frames extracted");

  // 2) Pick starting frame
  let chosen: any | null = null;
  let startIndex = 0;
  const at =
    typeof options?.previewAtSeconds === "number" &&
    options.previewAtSeconds >= 0
      ? Math.floor(options.previewAtSeconds)
      : null;
  if (at !== null) {
    // Choose nearest frame to the requested second by frameNumber proximity
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const dist = Math.abs(frames[i].frameNumber - 1 - at);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    startIndex = bestIdx;
  }

  // 3) OCR forward from startIndex to find a frame with meaningful text; then fallback backward
  const hasMeaningful = (s: string) => /[\p{L}\p{N}\u3400-\u9fff]/u.test(s);
  const tryIndex = async (idx: number) => {
    const detections = await detectTextInFrames([frames[idx]]);
    const det = detections[0];
    if (!det?.texts?.length) return null;
    const grouped = groupTextsIntoLines(det as any);
    const merged = grouped.texts
      .map((t) => t.text)
      .join(" ")
      .trim();
    if (merged && hasMeaningful(merged)) {
      return { det, grouped };
    }
    return null;
  };

  for (let i = startIndex; i < frames.length; i++) {
    const found = await tryIndex(i);
    if (found) {
      chosen = found;
      break;
    }
  }
  if (!chosen) {
    for (let i = startIndex - 1; i >= 0; i--) {
      const found = await tryIndex(i);
      if (found) {
        chosen = found;
        break;
      }
    }
  }
  if (!chosen) throw new Error("No text found to preview");

  // 3) Use grouped from chosen
  const grouped: GroupedFrame = (chosen as any).grouped;

  // 4) Translate only that frame's texts
  const unique = Array.from(
    new Set<string>(grouped.texts.map((t) => t.text))
  );
  const translationMap: Record<string, string> = await translateTexts(
    unique,
    targetLanguage
  );
  const translatedFrame: TranslatedFrame = {
    frameNumber: (chosen as any).det.frameNumber,
    texts: grouped.texts.map((t) => ({
      ...t,
      translatedText:
        process.env.NORMALIZE_CJK_SPACING === "0"
          ? translationMap[t.text] || t.text
          : normalizeCJKSpacing(translationMap[t.text] || t.text),
    })),
  } as unknown as TranslatedFrame;

  // 5) Render PNG preview
  const previewPath = path.resolve(workDir, "preview.png");
  await renderSubtitlesPreview(
    absoluteVideoPath,
    translatedFrame,
    previewPath,
    options || {}
  );
  return { previewPath, workDir, frameNumber: translatedFrame.frameNumber };
}

type OCRBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize?: number;
};

type FrameDet = {
  framePath: string;
  frameName: string;
  frameNumber: number;
  texts: OCRBox[];
};

type GroupedFrame = {
  framePath: string;
  frameName: string;
  frameNumber: number;
  texts: {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
  }[];
};

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
    const original = sorted.map((i) => i.text).join(" ");
    return { text: original, x: minX, y: minY, width, height, fontSize };
  });

  return {
    framePath: frame.framePath,
    frameName: frame.frameName,
    frameNumber: frame.frameNumber,
    texts: groups,
  };
}

function filterSubtitleLike(frames: GroupedFrame[]): GroupedFrame[] {
  const region = (process.env.SUBTITLE_REGION || 'bottom').toLowerCase();
  const regionFrac = Math.min(1, Math.max(0.05, Number(process.env.SUBTITLE_REGION_FRACTION || 0.5)));
  const minChars = Math.max(1, Number(process.env.SUBTITLE_MIN_CHARS || 6));
  const minWords = Math.max(1, Number(process.env.SUBTITLE_MIN_WORDS || 2));
  const minAspect = Math.max(1, Number(process.env.SUBTITLE_MIN_ASPECT || 3));
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

export async function translateVideoAss(
  videoPath: string,
  targetLanguage: string,
  options?: SubtitleOptions
) {
  const startTime = Date.now();
  const absoluteVideoPath = path.resolve(videoPath);
  const workDir = path.resolve(`./temp/job_${Date.now()}`);

  try {
    console.log("📁 Creating working directory...");
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(`${workDir}/frames`, { recursive: true });

    console.log("🎞️  Step 1: Extracting frames (1 fps)...");
    const frames = await extractFrames(absoluteVideoPath, `${workDir}/frames`);
    console.log(`   ✅ Extracted ${frames.length} frames`);
    const durationSec = Math.round(await getVideoDuration(absoluteVideoPath));
    const SKIP_INTRO_SECONDS = Number(process.env.SKIP_INTRO_SECONDS || 0);
    const SKIP_OUTRO_SECONDS = Number(process.env.SKIP_OUTRO_SECONDS || 0);
    const filteredFrames = frames.filter((f: any) => {
      const t = f.frameNumber - 1;
      if (t < SKIP_INTRO_SECONDS) return false;
      if (
        SKIP_OUTRO_SECONDS > 0 &&
        t >= Math.max(0, durationSec - SKIP_OUTRO_SECONDS)
      )
        return false;
      return true;
    });

    console.log("🔍 Step 2: Detecting text with OCR...");
    const detections: FrameDet[] = await detectTextInFrames(filteredFrames);
    console.log(
      `   ✅ Detected text in ${
        detections.filter((d) => d.texts.length > 0).length
      } frames`
    );

    console.log("📝 Step 3: Grouping OCR words into lines...");
    const groupedFrames: GroupedFrame[] = detections.map(groupTextsIntoLines);
    const subtitleFrames: GroupedFrame[] = filterSubtitleLike(groupedFrames);

    const uniquePhrases = new Set<string>();
    subtitleFrames.forEach((frame) =>
      frame.texts.forEach((t) => uniquePhrases.add(t.text))
    );

    console.log(`🌍 Step 4: Translating to ${targetLanguage}...`);
    const translationMap: Record<string, string> = await translateTexts(
      Array.from(uniquePhrases),
      targetLanguage
    );
    console.log(`   ✅ Translated ${Object.keys(translationMap).length} texts`);

    console.log("🎨 Step 5: Applying translations to frames...");
    const translatedFrames: TranslatedFrame[] = subtitleFrames.map((frame) => ({
      ...frame,
      texts: frame.texts.map((textObj) => ({
        ...textObj,
        translatedText:
          process.env.NORMALIZE_CJK_SPACING === "0"
            ? translationMap[textObj.text] || textObj.text
            : normalizeCJKSpacing(translationMap[textObj.text] || textObj.text),
      })),
    })) as unknown as TranslatedFrame[];

    console.log(
      "🎬 Step 6: Creating video with subtitles (ASS bottom-center)..."
    );
    const outputPath = path.resolve(workDir, "output_translated.mp4");
    await overlaySubtitlesBottomCenter(
      absoluteVideoPath,
      translatedFrames,
      outputPath,
      options || {}
    );
    console.log(`   ✅ Video created: ${outputPath}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const outputSize = (await fs.stat(outputPath)).size;

    console.log("");
    console.log("✨ Translation complete!");
    console.log(`   ⏱️  Duration: ${duration}s`);
    console.log(
      `   📊 Translations applied: ${Object.keys(translationMap).length}`
    );
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
    console.error("❌ Error in translation workflow:", error);
    throw error;
  }
}
