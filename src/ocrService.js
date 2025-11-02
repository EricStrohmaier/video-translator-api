import { promises as fs } from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const VISION_API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`;

/**
 * Detect text in a single frame using Google Vision API
 * @param {string} imagePath - Path to image file
 * @returns {Promise<Array>} Array of detected texts with positions
 */
async function detectTextInFrame(imagePath) {
  try {
    // Read image and convert to base64
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString("base64");

    // Call Google Vision API
    const response = await fetch(VISION_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64Image },
            features: [{ type: "TEXT_DETECTION", maxResults: 100 }],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Vision API error: ${response.statusText}`);
    }

    const data = await response.json();
    const annotations = data.responses?.[0]?.textAnnotations || [];

    if (annotations.length === 0) {
      return [];
    }

    // Skip first annotation (full text), process individual words
    const texts = [];
    for (let i = 1; i < annotations.length; i++) {
      const annotation = annotations[i];
      const vertices = annotation.boundingPoly.vertices;

      // Calculate bounding box
      const x = Math.min(...vertices.map((v) => v.x || 0));
      const y = Math.min(...vertices.map((v) => v.y || 0));
      const width = Math.max(...vertices.map((v) => v.x || 0)) - x;
      const height = Math.max(...vertices.map((v) => v.y || 0)) - y;

      texts.push({
        text: annotation.description,
        x,
        y,
        width,
        height,
        fontSize: Math.round(height * 0.8), // Estimate font size
      });
    }

    return texts;
  } catch (error) {
    console.error(`   ⚠️  OCR failed for ${imagePath}:`, error.message);
    return [];
  }
}

/**
 * Detect text in multiple frames
 * @param {Array} frames - Array of frame objects with path and frameNumber
 * @returns {Promise<Array>} Array of detection results
 */
export async function detectTextInFrames(frames) {
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

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(""); // New line after progress
  return detections;
}
