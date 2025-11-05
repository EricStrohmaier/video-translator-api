import { promises as fs } from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import type { TextBox } from "./types.js";

dotenv.config();

const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY!;
const VISION_API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`;

interface VisionResponse {
  responses?: Array<{
    textAnnotations?: Array<{
      description: string;
      boundingPoly: {
        vertices: Array<{ x?: number; y?: number }>;
      };
      confidence?: number;
    }>;
  }>;
}

/**
 * Clean and validate OCR text
 */
function isValidText(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  // Filter out single decorative symbols
  if (text.length === 1 && /[→←↑↓•·◆▪▫■□●○★☆]/.test(text)) {
    return false;
  }

  // Filter out Arabic/Persian/Hebrew characters (common OCR noise)
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/.test(text)) {
    return false;
  }

  if ((process.env.OCR_FILTER_STANDALONE_NUMBERS || '0') === '1') {
    if (/^\d{1,3}$/.test(text) && text.length <= 3) {
      return false;
    }
  }

  if (/^\d+$/.test(text)) {
    if (text.length >= 2 && (process.env.OCR_ALLOW_MULTI_DIGIT_NUMBERS || '0') !== '1') {
      return false;
    }
  }

  // Filter out single characters that are just punctuation or symbols
  if (text.length === 1 && /[^\p{L}\p{N}]/u.test(text)) {
    return false;
  }

  // Filter out random character combinations that aren't words
  if (text.length < 2 && !/[a-zA-Z\u3400-\u9fff]/.test(text)) {
    if (!/^\d$/.test(text)) {
      return false;
    }
  }

  // Must contain at least one letter (not just numbers/symbols)
  if (!/[\p{L}]/u.test(text)) {
    if (!/^\d$/.test(text)) {
      return false;
    }
  }

  return true;
}

/**
 * Clean OCR text
 */
function cleanOCRText(text: string): string {
  if (!text) return text;

  // Remove zero-width characters
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Remove combining diacritical marks that are artifacts
  text = text.replace(/[\u0300-\u036F]/g, '');

  // Trim whitespace
  text = text.trim();

  return text;
}

/**
 * Detect text in a single frame image
 */
export async function detectTextInFrame(imagePath: string): Promise<TextBox[]> {
  try {
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString("base64");

    const response = await fetch(VISION_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64Image },
            features: [
              {
                type: "TEXT_DETECTION",
                maxResults: 100,
              },
            ],
            imageContext: {
              languageHints: ["en"], // Hint for English text
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Vision API error: ${response.statusText}`);
    }

    const data = await response.json() as VisionResponse;
    const annotations = data.responses?.[0]?.textAnnotations || [];

    if (annotations.length === 0) {
      return [];
    }

    const texts: TextBox[] = [];
    // Skip first annotation (full text), process individual words
    for (let i = 1; i < annotations.length; i++) {
      const annotation = annotations[i];
      const cleanedText = cleanOCRText(annotation.description);

      // Skip invalid text
      if (!isValidText(cleanedText)) {
        continue;
      }

      const vertices = annotation.boundingPoly.vertices;

      const x = Math.min(...vertices.map((v) => v.x || 0));
      const y = Math.min(...vertices.map((v) => v.y || 0));
      const width = Math.max(...vertices.map((v) => v.x || 0)) - x;
      const height = Math.max(...vertices.map((v) => v.y || 0)) - y;

      // Skip tiny boxes (likely noise)
      if (width < 5 || height < 5) {
        continue;
      }

      texts.push({
        text: cleanedText,
        x,
        y,
        width,
        height,
        fontSize: Math.round(height * 0.8),
      });
    }

    return texts;
  } catch (error) {
    console.error(
      `   ⚠️  OCR failed for ${imagePath}:`,
      (error as Error).message
    );
    return [];
  }
}

/**
 * Detect text in multiple frames
 */
export async function detectTextInFrames(
  frames: Array<{ path: string; name: string; frameNumber: number }>
): Promise<
  Array<{
    framePath: string;
    frameName: string;
    frameNumber: number;
    texts: TextBox[];
  }>
> {
  const detections = [];

  for (const frame of frames) {
    process.stdout.write(
      `   Processing frame ${frame.frameNumber}/${frames.length}...\r`
    );

    const texts = await detectTextInFrame(frame.path);

    detections.push({
      framePath: frame.path,
      frameName: frame.name,
      frameNumber: frame.frameNumber,
      texts,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(""); // New line after progress
  return detections;
}
