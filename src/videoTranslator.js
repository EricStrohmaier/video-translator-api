import { promises as fs } from "fs";
import { extractFrames, getVideoDuration } from "./frameExtractor.js";
import { detectTextInFrames } from "./ocrService.js";
import { translateTexts } from "./translationService.js";
import { overlayTranslatedText } from "./videoComposer.js";
import dotenv from "dotenv";
dotenv.config();

function normalizeCJKSpacing(s) {
  if (!s) return s;
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
  if (!hasCJK) return s;
  // Remove spaces within CJK text while preserving spaces around numbers and Latin blocks
  return s.replace(
    /([\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3400-\u9fff\uf900-\ufaff])/g,
    "$1"
  );
}

function groupTextsIntoLines(frame) {
  const items = (frame.texts || [])
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);

  function overlapsY(a, b) {
    const top = Math.max(a.y, b.y);
    const bottom = Math.max(top, Math.min(a.y + a.height, b.y + b.height));
    const inter = bottom - top;
    const minH = Math.max(1, Math.min(a.height, b.height));
    return inter / minH >= 0.5; // at least 50% overlap with the shorter box
  }

  const lines = [];
  for (const t of items) {
    let placed = false;
    for (const line of lines) {
      // compare with the line's current vertical span
      if (overlapsY(t, line.span)) {
        line.items.push(t);
        // expand span
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
    // merge tokens into one phrase
    const minX = Math.min(...sorted.map((i) => i.x));
    const minY = Math.min(...sorted.map((i) => i.y));
    const maxX = Math.max(...sorted.map((i) => i.x + i.width));
    const maxY = Math.max(...sorted.map((i) => i.y + i.height));
    const width = maxX - minX;
    const height = maxY - minY;
    const fontSize = Math.round(
      Math.max(...sorted.map((i) => i.fontSize || Math.round(i.height * 0.8)))
    );
    // Join with spaces for Latin, but translation will output CJK without spaces.
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

/**
 * Main workflow: Translate text in video
 * @param {string} videoPath - Path to input video
 * @param {string} targetLanguage - Target language for translation
 * @returns {Promise<Object>} Result with output path and stats
 */
export async function translateVideo(videoPath, targetLanguage) {
  const startTime = Date.now();
  const workDir = `./temp/job_${Date.now()}`;

  try {
    console.log("📁 Creating working directory...");
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(`${workDir}/frames`, { recursive: true });

    // Step 1: Extract frames from video
    console.log("🎞️  Step 1: Extracting frames (1 fps)...");
    const frames = await extractFrames(videoPath, `${workDir}/frames`);
    console.log(`   ✅ Extracted ${frames.length} frames`);
    const durationSec = Math.round(await getVideoDuration(videoPath));
    const SKIP_INTRO_SECONDS = Number(process.env.SKIP_INTRO_SECONDS || 0);
    const SKIP_OUTRO_SECONDS = Number(process.env.SKIP_OUTRO_SECONDS || 0);
    const filteredFrames = frames.filter((f) => {
      const t = f.frameNumber - 1; // 1 fps mapping
      if (t < SKIP_INTRO_SECONDS) return false;
      if (
        SKIP_OUTRO_SECONDS > 0 &&
        t >= Math.max(0, durationSec - SKIP_OUTRO_SECONDS)
      )
        return false;
      return true;
    });
    if (filteredFrames.length !== frames.length) {
      console.log(
        `   ⏭️  Skipping intro/outro seconds (intro=${SKIP_INTRO_SECONDS}, outro=${SKIP_OUTRO_SECONDS}). Using ${filteredFrames.length}/${frames.length} frames.`
      );
    }

    // Step 2: OCR - Detect text in each frame
    console.log("🔍 Step 2: Detecting text with OCR...");
    const detections = await detectTextInFrames(filteredFrames);
    console.log(
      `   ✅ Detected text in ${
        detections.filter((d) => d.texts.length > 0).length
      } frames`
    );
    if (process.env.DEBUG_OCR === "1") {
      await fs.writeFile(
        `${workDir}/detections.json`,
        JSON.stringify(detections, null, 2)
      );
    }

    // Step 3: Group words into line-level phrases per frame
    console.log("📝 Step 3: Grouping OCR words into lines...");
    const groupedFrames = detections.map(groupTextsIntoLines);
    if (process.env.DEBUG_OCR === "1") {
      await fs.writeFile(
        `${workDir}/grouped.json`,
        JSON.stringify(groupedFrames, null, 2)
      );
    }
    const uniquePhrases = new Set();
    groupedFrames.forEach((frame) =>
      frame.texts.forEach((t) => uniquePhrases.add(t.text))
    );
    console.log(
      `   ✅ Found ${uniquePhrases.size} unique phrases to translate`
    );

    // Step 4: Translate all phrases
    console.log(`🌍 Step 4: Translating to ${targetLanguage}...`);
    const translationMap = await translateTexts(
      Array.from(uniquePhrases),
      targetLanguage
    );
    console.log(`   ✅ Translated ${Object.keys(translationMap).length} texts`);
    if (process.env.DEBUG_TRANSLATION === "1") {
      await fs.writeFile(
        `${workDir}/translations.json`,
        JSON.stringify(translationMap, null, 2)
      );
    }

    // Step 5: Apply translations to grouped frames
    console.log("🎨 Step 5: Applying translations to frames...");
    const translatedFrames = groupedFrames.map((frame) => ({
      ...frame,
      texts: frame.texts.map((textObj) => ({
        ...textObj,
        translatedText:
          process.env.NORMALIZE_CJK_SPACING === "0"
            ? translationMap[textObj.text] || textObj.text
            : normalizeCJKSpacing(translationMap[textObj.text] || textObj.text),
      })),
    }));

    // Step 6: Overlay translated text on video
    console.log("🎬 Step 6: Creating video with translated text overlays...");
    const outputPath = `${workDir}/output_translated.mp4`;
    await overlayTranslatedText(videoPath, translatedFrames, outputPath);
    console.log(`   ✅ Video created: ${outputPath}`);

    // Calculate stats
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
        framesProcessed: frames.length,
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
