import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Extract frames from video at 1 fps
 * @param {string} videoPath - Path to input video
 * @param {string} outputDir - Directory to save frames
 * @returns {Promise<Array>} Array of frame file paths
 */
export async function extractFrames(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const frames = [];
    
    ffmpeg(videoPath)
      .outputOptions([
        '-vf fps=1',  // 1 frame per second
      ])
      .output(`${outputDir}/frame_%04d.png`)
      .on('end', async () => {
        try {
          // Read all frame files
          const files = await fs.readdir(outputDir);
          const frameFiles = files
            .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
            .sort()
            .map((f, index) => ({
              path: path.join(outputDir, f),
              name: f,
              frameNumber: index + 1
            }));
          
          resolve(frameFiles);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', (error) => {
        reject(new Error(`FFmpeg error: ${error.message}`));
      })
      .run();
  });
}

/**
 * Get video duration in seconds
 * @param {string} videoPath - Path to video file
 * @returns {Promise<number>} Duration in seconds
 */
export async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
}
