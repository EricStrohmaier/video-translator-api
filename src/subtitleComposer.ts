import ffmpeg from 'fluent-ffmpeg';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

dotenv.config();

// Env controls (simple, hex-based)
const ASS_BASE_FONTSIZE = Number(process.env.ASS_BASE_FONTSIZE || 44);
const ASS_BOX_PAD = Number(process.env.ASS_BOX_PAD || 10);
const ASS_MARGIN_V = Number(process.env.ASS_MARGIN_V || 90);
const DEBUG_COMPOSER = process.env.DEBUG_COMPOSER === '1';
const ASS_FORCE_ONE_LINE = process.env.ASS_FORCE_ONE_LINE === '1';

// Rough width factors to estimate if one-line will fit
const CJK_WIDTH_FACTOR = Number(process.env.CJK_WIDTH_FACTOR || 0.9);
const LATIN_WIDTH_FACTOR = Number(process.env.LATIN_WIDTH_FACTOR || 0.62);

// Hex colors like #RRGGBB or #RRGGBBAA. Convert to ASS &HAABBGGRR
function hexToAss(hex: string | undefined, defaultHex?: string): string {
  let h = (hex || defaultHex || '').replace(/^#/, '').trim();
  if (!/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h)) {
    h = (defaultHex || '000000').replace(/^#/, '');
  }
  if (h.length === 6) {
    // opaque
    const rr = h.slice(0, 2);
    const gg = h.slice(2, 4);
    const bb = h.slice(4, 6);
    return `&H00${bb}${gg}${rr}`;
  }
  // 8-digit RGBA
  const rr = h.slice(0, 2);
  const gg = h.slice(2, 4);
  const bb = h.slice(4, 6);
  const aa = h.slice(6, 8); // alpha 00=opaque, FF=transparent in RGBA
  return `&H${aa}${bb}${gg}${rr}`;
}

const SUB_TEXT_ASS = hexToAss(process.env.SUB_TEXT_COLOR, 'FFFFFF'); // default white text
const SUB_BG_ASS = hexToAss(process.env.SUB_BG_COLOR, '00000080'); // default semi-black badge

// Optional external font (e.g., Google/Noto): provide a direct .ttf/.otf URL and optional name
const ASS_FONT_URL = process.env.ASS_FONT_URL || '';
const ASS_FONT_NAME = process.env.ASS_FONT_NAME || '';

type FrameText = { translatedText?: string };
export type TranslatedFrame = { frameNumber: number; texts: FrameText[] };

export type SubtitleOptions = {
  baseFontSize?: number;
  boxPad?: number;
  marginV?: number;
  textColorHex?: string; // #RRGGBB[AA]
  bgColorHex?: string;   // #RRGGBB[AA]
  forceOneLine?: boolean;
  fontUrl?: string;
  fontName?: string;
  cjkWidthFactor?: number;
  latinWidthFactor?: number;
  // Soft badge controls (Option A)
  roundedRadius?: number; // visual softness via blur
  bgBlur?: number;        // pixels to blur the shape edges
};

async function ensureExternalFont(fontUrl: string, fontsDir: string): Promise<{ fname: string; fpath: string } | null> {
  if (!fontUrl) return null;
  await fs.mkdir(fontsDir, { recursive: true });
  const toRaw = (u: string) => {
    // Convert GitHub blob URLs to raw
    // https://github.com/org/repo/blob/branch/path -> https://raw.githubusercontent.com/org/repo/branch/path
    try {
      const url = new URL(u);
      if (url.hostname === 'github.com' && url.pathname.includes('/blob/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const org = parts[0];
        const repo = parts[1];
        const blobIdx = parts.indexOf('blob');
        const branch = parts[blobIdx + 1];
        const rest = parts.slice(blobIdx + 2).join('/');
        return `https://raw.githubusercontent.com/${org}/${repo}/${branch}/${rest}`;
      }
      if (url.hostname === 'raw.githubusercontent.com') return u;
    } catch {}
    return u;
  };

  const normalized = toRaw(fontUrl);
  const fname = decodeURIComponent(normalized.split('/').pop() || 'font.otf');
  const fpath = path.join(fontsDir, fname);
  const isLikelyFont = async (p: string) => {
    try {
      const fd = await fs.open(p, 'r');
      const { buffer } = await fd.read(Buffer.alloc(4), 0, 4, 0);
      await fd.close();
      const sig = buffer.toString('ascii');
      // OTF starts with 'OTTO'; TTF starts with 0x00010000 or 'true'/'typ1'
      if (sig === 'OTTO') return true;
      const n = buffer.readUInt32BE(0);
      return n === 0x00010000 || sig === 'true' || sig === 'typ1';
    } catch {
      return false;
    }
  };

  let needDownload = true;
  try { if (await isLikelyFont(fpath)) needDownload = false; } catch {}
  if (needDownload) {
    const tryFetch = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download font: ${res.status} ${res.statusText}`);
      const buf = await res.arrayBuffer();
      await fs.writeFile(fpath, Buffer.from(buf));
    };
    try {
      await tryFetch(normalized);
      if (!(await isLikelyFont(fpath))) {
        // fallback: append ?raw=1 for GitHub UI links
        await tryFetch(`${fontUrl}${fontUrl.includes('?') ? '' : '?raw=1'}`);
      }
    } catch (e) {
      try { await fs.unlink(fpath); } catch {}
      throw e;
    }
  }
  return { fname, fpath };
}

function deriveFontNameFromFilename(fname: string): string {
  const base = fname.replace(/\.(ttf|otf)$/i, '');
  if (/NotoSansCJKsc/i.test(base)) return 'Noto Sans CJK SC';
  if (/NotoSansSC/i.test(base)) return 'Noto Sans SC';
  if (/SourceHanSansSC/i.test(base)) return 'Source Han Sans SC';
  if (/NotoSerifCJKsc/i.test(base)) return 'Noto Serif CJK SC';
  return base;
}

function isCJK(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(s || '');
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${c.toString().padStart(2,'0')}`;
}

function escAss(s: string): string {
  return String(s || '')
    .replace(/\\/g, '\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\n/g, '\\N');
}

function mergeFrameTexts(frames: { frameNumber: number; text: string }[], fps = 1) {
  const events: { text: string; start: number; end: number }[] = [];
  let current: { text: string; start: number; end: number } | null = null;
  for (const f of frames) {
    const t = f.text || '';
    const startSec = (f.frameNumber - 1) / fps;
    const endSec = f.frameNumber / fps;
    if (!current) {
      current = { text: t, start: startSec, end: endSec };
      continue;
    }
    if (t === current.text) {
      current.end = endSec;
    } else {
      events.push(current);
      current = { text: t, start: startSec, end: endSec };
    }
  }
  if (current) events.push(current);
  return events;
}

/**
 * Compose bottom-center ASS subtitles based on translated frames.
 * - one line if fits 90% width else two lines
 * - white badge background, bold
 */
export async function overlaySubtitlesBottomCenter(inputPath: string, translatedFrames: TranslatedFrame[], outputPath: string, opts: SubtitleOptions = {}) {
  const perFrame = translatedFrames.map((frame) => {
    const parts = (frame.texts || [])
      .map((t) => (t?.translatedText || '').trim())
      .filter(Boolean);
    const mergedOne = parts.join(' ');
    return { frameNumber: frame.frameNumber, text: mergedOne };
  });

  const meta: any = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, m) => (err ? reject(err) : resolve(m)));
  });
  const vStream = Array.isArray(meta?.streams) ? meta.streams.find((s: any) => s.codec_type === 'video') : null;
  const vW = Number(vStream?.width || 1280);
  const vH = Number(vStream?.height || 720);

  const baseFontSize = Number(opts.baseFontSize ?? ASS_BASE_FONTSIZE);
  const boxPad = Number(opts.boxPad ?? ASS_BOX_PAD);
  const marginV = Number(opts.marginV ?? ASS_MARGIN_V);
  const textAss = hexToAss(opts.textColorHex, SUB_TEXT_ASS);
  const backAss = hexToAss(opts.bgColorHex, SUB_BG_ASS);
  const forceOneLine = Boolean(opts.forceOneLine ?? ASS_FORCE_ONE_LINE);
  const cjkFactor = Number(opts.cjkWidthFactor ?? CJK_WIDTH_FACTOR);
  const latinFactor = Number(opts.latinWidthFactor ?? LATIN_WIDTH_FACTOR);
  const roundedRadius = Math.max(0, Number(opts.roundedRadius ?? 0));
  const bgBlur = Math.max(0, Number(opts.bgBlur ?? 0));

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${vW}`,
    `PlayResY: ${vH}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // If using soft badge, disable opaque box (BorderStyle=1 and fully transparent BackColour)
    roundedRadius > 0 || bgBlur > 0
      ? `Style: Default,Arial,${baseFontSize},${textAss},&H000000FF,&H00000000,&HFF000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,${marginV},1`
      : `Style: Default,Arial,${baseFontSize},${textAss},&H000000FF,&H00000000,${backAss},-1,0,0,0,100,100,0,0,3,0,0,2,10,10,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const decided = perFrame.map((pf) => {
    const s = pf.text;
    if (!s) return { frameNumber: pf.frameNumber, text: '' };
    const cjk = isCJK(s);
    const factor = cjk ? cjkFactor : latinFactor;
    const maxWidth = Math.floor(vW * 0.9) - boxPad * 2;
    const est = s.length * factor * baseFontSize;
    let out = s;
    if (!forceOneLine && est > maxWidth) {
      const tokens = cjk ? s.split('') : s.split(/\s+/);
      const half = Math.ceil(tokens.length / 2);
      if (cjk) {
        out = tokens.slice(0, half).join('') + '\n' + tokens.slice(half).join('');
      } else {
        const words = s.split(/\s+/);
        const l = words.slice(0, Math.ceil(words.length / 2)).join(' ');
        const r = words.slice(Math.ceil(words.length / 2)).join(' ');
        out = `${l}\n${r}`;
      }
    }
    return { frameNumber: pf.frameNumber, text: out };
  });

  const merged = mergeFrameTexts(decided, 1);

  const events: string[] = [];
  const posX = Math.round(vW / 2);
  const posY = Math.round(vH - marginV);

  const assColorParts = (ass: string) => {
    // ass like &HAABBGGRR -> return { a: 'AA', c: 'BBGGRR' }
    const m = /^&H([0-9A-Fa-f]{2})([0-9A-Fa-f]{6})$/.exec(ass);
    if (!m) return { a: '00', c: '000000' };
    return { a: m[1].toUpperCase(), c: m[2].toUpperCase() };
  };
  const backParts = assColorParts(backAss);
  for (const ev of merged) {
    if (!ev.text) continue;
    const start = assTime(ev.start);
    const end = assTime(ev.end);
    const t = escAss(ev.text);

    // Compute box size based on lines
    const lines = t.split('\\N');
    const lineHeights = lines.map(() => baseFontSize);
    const lineGap = Math.round(baseFontSize * 0.15);
    const contentH = lineHeights.reduce((acc, h, i) => acc + h + (i ? lineGap : 0), 0);
    const estWidths = lines.map((ln) => (ln.length * (isCJK(ln) ? cjkFactor : latinFactor) * baseFontSize));
    const contentW = Math.max(1, Math.round(Math.max(...estWidths)));
    const padX = boxPad;
    const padY = boxPad;
    const boxW = Math.round(contentW + padX * 2);
    const boxH = Math.round(contentH + padY * 2);

    // Optional soft badge via vector drawing
    let shape = '';
    if (roundedRadius > 0 || bgBlur > 0) {
      // Draw rectangle centered at (posX,posY) using bottom-center anchor (an2), y from -boxH to 0
      const halfW = Math.round(boxW / 2);
      // Use blur as softness; roundedRadius contributes to perceived roundness
      const blurAmt = Math.max(bgBlur, roundedRadius);
      shape = `{\\an2\\pos(${posX},${posY})\\p1\\c&H${backParts.c}&\\alpha&H${backParts.a}&\\bord0${blurAmt > 0 ? `\\blur${blurAmt}` : ''}}m ${-halfW},${-boxH} l ${halfW},${-boxH} l ${halfW},0 l ${-halfW},0{\\p0}`;
    }

    const textTag = roundedRadius > 0 || bgBlur > 0
      ? `{\\an2\\pos(${posX},${posY})\\fs${baseFontSize}\\bord0\\b1}`
      : `{\\an2\\pos(${posX},${posY})\\fs${baseFontSize}\\bord${boxPad}\\b1}`;
    events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${shape}${textTag}${t}`);
  }

  const outDir = path.dirname(outputPath);
  const assPath = path.join(outDir, 'overlays.ass');
  const assContent = header.concat(events).join('\n');
  await fs.writeFile(assPath, assContent);

  const assEsc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  let subFilter = `subtitles='${assEsc}'`;
  if (ASS_FONT_URL) {
    const fontsDir = path.join(outDir, 'fonts');
    try {
      const info = await ensureExternalFont(opts.fontUrl ?? ASS_FONT_URL, fontsDir);
      if (info) {
        const fontsDirEsc = fontsDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
        const chosenName = (opts.fontName && opts.fontName.trim().length > 0 ? opts.fontName : (ASS_FONT_NAME && ASS_FONT_NAME.trim().length > 0 ? ASS_FONT_NAME : deriveFontNameFromFilename(info.fname)));
        const fontName = chosenName.replace(/:/g, '\\:').replace(/'/g, "\\'");
        subFilter = `subtitles='${assEsc}':fontsdir='${fontsDirEsc}':force_style='FontName=${fontName}'`;
        if (DEBUG_COMPOSER) console.log(`   [debug] Using external font '${chosenName}' from ${info.fname}`);
      }
    } catch (e: any) {
      if (DEBUG_COMPOSER) console.log(`   [warn] External font failed: ${e.message}`);
    }
  }
  const filterComplex = `scale=trunc(iw/2)*2:trunc(ih/2)*2,${subFilter}`;

  const run = (videoCodec: 'h264_videotoolbox' | 'libx264') => new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(inputPath)
      .videoFilters(filterComplex)
      .videoCodec(videoCodec)
      .outputOptions(['-movflags', '+faststart'])
      .output(outputPath);

    if (videoCodec === 'libx264') {
      cmd.outputOptions(['-pix_fmt', 'yuv420p']);
    }

    cmd
      .audioCodec(process.platform === 'darwin' ? 'aac_at' : 'aac')
      .audioBitrate('192k')
      .audioChannels(2)
      .audioFrequency(48000);

    if (DEBUG_COMPOSER) cmd.outputOptions(['-loglevel', 'verbose']);

    cmd.on('start', (cl: string) => { if (DEBUG_COMPOSER) console.log(`   [debug] FFmpeg command: ${cl}`); })
      .on('stderr', (line: string) => { if (DEBUG_COMPOSER) console.log(`   [ffmpeg] ${line}`); })
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });

  try {
    if (process.platform === 'darwin') {
      await run('h264_videotoolbox');
    } else {
      await run('libx264');
    }
  } catch {
    await run(process.platform === 'darwin' ? 'libx264' : 'h264_videotoolbox');
  }
}

// Preview renderer: outputs a single PNG using the same ASS styling
export async function renderSubtitlesPreview(inputPath: string, frame: TranslatedFrame, outputPngPath: string, opts: SubtitleOptions = {}) {
  const tempVideoOut = path.join(path.dirname(outputPngPath), 'preview_tmp_video.mp4');
  await overlaySubtitlesBottomCenter(inputPath, [frame], tempVideoOut, opts);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(tempVideoOut)
      .outputOptions(['-vframes', '1'])
      .output(outputPngPath)
      .on('end', () => resolve())
      .on('error', (e) => reject(e))
      .run();
  });
}
