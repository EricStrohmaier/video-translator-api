import ffmpeg from 'fluent-ffmpeg';
import dotenv from 'dotenv';
import { existsSync } from 'fs';

dotenv.config();

const FONT_CANDIDATES = [
  process.env.FONT_FILE,
  process.env.CJK_FONT_FILE,
  '/System/Library/Fonts/PingFang.ttc',
  '/Library/Fonts/NotoSansCJK-Regular.ttc',
  '/Library/Fonts/NotoSansCJK.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode MS.ttf',
  '/System/Library/Fonts/STHeiti Light.ttc'
].filter(Boolean);

function pickFont() {
  for (const p of FONT_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

const FONT_FILE = pickFont();
const TEXT_COLOR = process.env.TEXT_COLOR || 'white';
const BOX_COLOR = process.env.BOX_COLOR || 'black@0.85';
const BOX_PADDING = Number(process.env.BOX_PADDING || 6);
const DEBUG_COMPOSER = process.env.DEBUG_COMPOSER === '1';
const TEXT_ALIGN = (process.env.TEXT_ALIGN || 'auto').toLowerCase(); // auto|left|center|right
const CJK_WIDTH_FACTOR = Number(process.env.CJK_WIDTH_FACTOR || 0.9);
const LATIN_WIDTH_FACTOR = Number(process.env.LATIN_WIDTH_FACTOR || 0.62);
const CJK_LINE_SPACING = Number(process.env.CJK_LINE_SPACING || 0.06);
const LATIN_LINE_SPACING = Number(process.env.LATIN_LINE_SPACING || 0.18);
const ENABLE_TEXT_SHAPING = process.env.ENABLE_TEXT_SHAPING === '1';
// Skipping intro/outro is handled upstream in videoTranslator by filtering frames.

function isCJK(str) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(str);
}

function wrapTextForBox(text, width, fontSize) {
  if (!text) return text;
  const cjk = isCJK(text);
  const factor = cjk ? CJK_WIDTH_FACTOR : LATIN_WIDTH_FACTOR; // rough char width factor
  const maxPerLine = Math.max(1, Math.floor(width / (fontSize * factor)));
  if (text.length <= maxPerLine) return text;
  const words = cjk ? text.split("") : text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const token of words) {
    const next = line ? (cjk ? line + token : (line + ' ' + token)) : token;
    if (next.length > maxPerLine && line) {
      lines.push(line);
      line = token;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function layoutForText(textObj) {
  const original = textObj.translatedText || '';
  const isC = isCJK(original);
  const factor = isC ? CJK_WIDTH_FACTOR : LATIN_WIDTH_FACTOR;
  const maxWidth = Math.max(10, textObj.width - BOX_PADDING * 2);
  // Initial wrap using given font size
  let wrapped = wrapTextForBox(original, textObj.width, textObj.fontSize);
  let lines = wrapped ? wrapped.split('\n') : [''];
  // Fit font size to the longest line
  const longest = Math.max(...lines.map(l => l.length), 1);
  let fitted = textObj.fontSize;
  const est = longest * factor * fitted;
  if (est > maxWidth) {
    fitted = Math.max(12, Math.floor(maxWidth / (longest * factor)));
    // Re-wrap using fitted size to try to reduce line count
    wrapped = wrapTextForBox(original, textObj.width, fitted);
    lines = wrapped ? wrapped.split('\n') : [''];
  }
  return { wrapped, lines, fitted, isC };
}

function xPositionExpr(textObj, isC) {
  // Alignment priority: explicit TEXT_ALIGN, else auto -> left for CJK, center otherwise
  const align = TEXT_ALIGN === 'auto' ? (isC ? 'left' : 'center') : TEXT_ALIGN;
  if (align === 'left') {
    return `${textObj.x}+${BOX_PADDING}`;
  }
  if (align === 'right') {
    return `${textObj.x}+${textObj.width}-text_w-${BOX_PADDING}`;
  }
  // center
  return `${textObj.x}+(${textObj.width}-text_w)/2`;
}

/**
 * Generate FFmpeg drawtext filter for a single text
 * @param {Object} textObj - Text object with position and translated text
 * @param {number} frameNumber - Frame number (for timing)
 * @returns {string} FFmpeg drawtext filter string
 */
function generateDrawtextFilter(textObj, frameNumber) {
  if (!textObj.translatedText) {
    return null;
  }
  
  // Escape special characters for FFmpeg
  const { wrapped, lines, fitted, isC } = layoutForText(textObj);
  const escaped = wrapped
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\n/g, "\\n");
  
  const startTime = frameNumber - 1;
  const endTime = frameNumber;
  
  const fontfileParam = FONT_FILE ? `fontfile='${FONT_FILE.replace(/'/g, "\\'")}':` : '';
  return `drawtext=text='${escaped}':` +
    fontfileParam +
    `x=${xPositionExpr(textObj, isC)}:` +
    `y=${textObj.y}+(${textObj.height}-text_h)/2:` +
    `fontsize=${fitted}:` +
    `fontcolor=${TEXT_COLOR}:` +
    `bordercolor=black@0.8:` +
    `borderw=1:` +
    `shadowcolor=black@0.6:` +
    `shadowx=2:` +
    `shadowy=2:` +
    `line_spacing=${Math.round(fitted*(isC?CJK_LINE_SPACING:LATIN_LINE_SPACING))}:` +
    (ENABLE_TEXT_SHAPING ? `text_shaping=1:` : '') +
    `fix_bounds=1:` +
    `enable='between(t,${startTime},${endTime})'`;
}

function generateDrawboxFilter(textObj, frameNumber) {
  const pad = Number.isFinite(BOX_PADDING) ? BOX_PADDING : 6;
  const x = Math.max(0, Math.round(textObj.x - pad));
  const y = Math.max(0, Math.round(textObj.y - pad));
  const w = Math.round(textObj.width + pad * 2);
  // Estimate height for wrapped lines using fitted metrics
  const { lines, fitted, isC } = layoutForText(textObj);
  const lineCount = lines.length || 1;
  const lineSpacing = Math.round(fitted * (isC ? 0.08 : 0.18));
  const lineHeight = Math.max(1, Math.round(fitted + lineSpacing));
  const textHeight = Math.max(textObj.height, lineCount * lineHeight - lineSpacing);
  const h = Math.round(textHeight + pad * 2);
  const startTime = frameNumber - 1;
  const endTime = frameNumber;
  return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${BOX_COLOR}:t=fill:enable='between(t,${startTime},${endTime})'`;
}

/**
 * Overlay translated text on video using FFmpeg
 * @param {string} inputPath - Input video path
 * @param {Array} translatedFrames - Array of frames with translated texts
 * @param {string} outputPath - Output video path
 * @returns {Promise<void>}
 */
export async function overlayTranslatedText(inputPath, translatedFrames, outputPath) {
  return new Promise((resolve, reject) => {
    // Generate all drawtext filters
    const filters = [];
    
    translatedFrames.forEach(frame => {
      if (!frame.texts || frame.texts.length === 0) return;
      
      frame.texts.forEach(textObj => {
        const box = generateDrawboxFilter(textObj, frame.frameNumber);
        const text = generateDrawtextFilter(textObj, frame.frameNumber);
        if (box) filters.push(box);
        if (text) filters.push(text);
      });
    });
    
    if (filters.length === 0) {
      console.log('   ⚠️  No text to overlay, copying original video');
      // Just copy the video if no text detected
      ffmpeg(inputPath)
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
      return;
    }
    
    if (DEBUG_COMPOSER) {
      console.log(`   [debug] Font: ${FONT_FILE || 'system default'}`);
      console.log(`   [debug] Filters: ${filters.length}`);
    }
    const filterComplex = filters.join(',');
    
    console.log(`   Applying ${filters.length} text overlays...`);
    
    // Apply the filter complex
    ffmpeg(inputPath)
      .videoFilters(filterComplex)
      .audioCodec('copy') // Keep original audio
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`   Progress: ${progress.percent.toFixed(1)}%\r`);
        }
      })
      .on('end', () => {
        console.log(''); // New line after progress
        resolve();
      })
      .on('error', (error) => {
        reject(new Error(`FFmpeg overlay error: ${error.message}`));
      })
      .run();
  });
}
