import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import type { FrameInfo } from './types.js';

/**
 * Extract frames from video at 1 fps
 */
export async function extractFrames(videoPath: string, outputDir: string): Promise<FrameInfo[]> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(['-vf fps=1'])
      .output(`${outputDir}/frame_%04d.png`)
      .on('end', async () => {
        try {
          const files = await fs.readdir(outputDir);
          const frameFiles: FrameInfo[] = files
            .filter((f) => f.startsWith('frame_') && f.endsWith('.png'))
            .sort()
            .map((f, index) => ({
              path: path.join(outputDir, f),
              name: f,
              frameNumber: index + 1,
            }));
          resolve(frameFiles);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', (error) => reject(new Error(`FFmpeg error: ${error.message}`)))
      .run();
  });
}

/**
 * Get video duration in seconds
 */
export async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format?.duration ?? 0);
    });
  });
}
