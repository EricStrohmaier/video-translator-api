import { Hono } from "hono";
import { cors } from "hono/cors";
import { translateVideoAss, previewVideoAss } from "./subtitleTranslator.js";
import { jobManager } from "./jobManager.js";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

dotenv.config();

// Helper function to download video from URL
async function downloadVideoFromUrl(
  url: string,
  destPath: string
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.statusText}`);
  }

  // Validate content type
  const contentType = response.headers.get("content-type");
  const allowedTypes = [
    "video/mp4",
    "video/quicktime",
    "video/x-msvideo",
    "video/webm",
  ];
  if (contentType && !allowedTypes.some((type) => contentType.includes(type))) {
    throw new Error(
      `Invalid video type from URL: ${contentType}. Allowed: MP4, MOV, AVI, WEBM`
    );
  }

  // Validate content length (max 100MB)
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const maxSize = 100 * 1024 * 1024; // 100MB
    if (parseInt(contentLength) > maxSize) {
      throw new Error("Video file too large. Maximum size: 100MB");
    }
  }

  const buffer = await response.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(buffer));
}

const app = new Hono();

// Enable CORS for frontend
app.use(
  "/*",
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  })
);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "uploads");
await fs.mkdir(uploadsDir, { recursive: true });

// Health check
app.get("/", (c) => {
  return c.json({
    status: "ok",
    message: "Video Text Translator API - Production",
    version: "2.0.0",
    endpoints: {
      upload: "POST /api/upload",
      jobs: "GET /api/jobs/:id",
      jobsList: "GET /api/jobs",
      preview: "POST /api/preview",
      download: "GET /api/download/:jobId",
      stats: "GET /api/stats",
    },
  });
});

// Upload video and create translation job
app.post("/api/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const videoFile = formData.get("video") as File | null;
    const videoUrl = formData.get("videoUrl") as string | null;
    const targetLanguage = formData.get("targetLanguage") as string;
    const optionsStr = formData.get("options") as string;

    // Require either file or URL
    if (!videoFile && !videoUrl) {
      return c.json(
        { success: false, error: "Either video file or videoUrl is required" },
        400
      );
    }

    if (videoFile && videoUrl) {
      return c.json(
        {
          success: false,
          error: "Provide either video file or videoUrl, not both",
        },
        400
      );
    }

    if (!targetLanguage) {
      return c.json(
        { success: false, error: "targetLanguage is required" },
        400
      );
    }

    // Parse options
    let options = {};
    if (optionsStr) {
      try {
        options = JSON.parse(optionsStr);
      } catch (e) {
        return c.json({ success: false, error: "Invalid options JSON" }, 400);
      }
    }

    // Create job
    const job = jobManager.createJob(targetLanguage, options);
    let videoPath: string;

    // Handle video file upload
    if (videoFile) {
      // Validate file type
      const allowedTypes = [
        "video/mp4",
        "video/quicktime",
        "video/x-msvideo",
        "video/webm",
      ];
      if (!allowedTypes.includes(videoFile.type)) {
        return c.json(
          {
            success: false,
            error: "Invalid file type. Allowed: MP4, MOV, AVI, WEBM",
          },
          400
        );
      }

      // Validate file size (max 100MB)
      const maxSize = 100 * 1024 * 1024; // 100MB
      if (videoFile.size > maxSize) {
        return c.json(
          {
            success: false,
            error: "File too large. Maximum size: 100MB",
          },
          400
        );
      }

      // Save uploaded file
      const fileExt = path.extname(videoFile.name) || ".mp4";
      videoPath = path.join(uploadsDir, `${job.id}${fileExt}`);
      const buffer = await videoFile.arrayBuffer();
      await fs.writeFile(videoPath, Buffer.from(buffer));
    }
    // Handle video URL
    else if (videoUrl) {
      try {
        videoPath = path.join(uploadsDir, `${job.id}.mp4`);
        await downloadVideoFromUrl(videoUrl, videoPath);
      } catch (error) {
        jobManager.setJobFailed(job.id, (error as Error).message);
        return c.json({ success: false, error: (error as Error).message }, 400);
      }
    } else {
      return c.json({ success: false, error: "Video source required" }, 400);
    }

    // Update job with video path
    jobManager.updateJob(job.id, { videoPath });

    // Process asynchronously
    processVideoJob(job.id, videoPath, targetLanguage, options).catch(
      (error) => {
        console.error(`Job ${job.id} failed:`, error);
        jobManager.setJobFailed(job.id, error.message);
      }
    );

    return c.json(
      {
        success: true,
        jobId: job.id,
        status: job.status,
        message: videoFile
          ? "Video uploaded successfully. Processing started."
          : "Video downloaded from URL. Processing started.",
      },
      202
    ); // 202 Accepted
  } catch (error) {
    console.error("❌ Upload error:", error);
    return c.json(
      {
        success: false,
        error: (error as Error).message,
      },
      500
    );
  }
});

// Get job status
app.get("/api/jobs/:id", (c) => {
  const jobId = c.req.param("id");
  const job = jobManager.getJob(jobId);

  if (!job) {
    return c.json({ success: false, error: "Job not found" }, 404);
  }

  return c.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      targetLanguage: job.targetLanguage,
      error: job.error,
      stats: job.stats,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      hasOutput: !!job.outputPath,
      hasPreview: !!job.previewPath,
    },
  });
});

// List all jobs (for admin/debugging)
app.get("/api/jobs", (c) => {
  const jobs = jobManager.getAllJobs().map((job) => ({
    id: job.id,
    status: job.status,
    progress: job.progress,
    targetLanguage: job.targetLanguage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }));

  return c.json({
    success: true,
    jobs,
    stats: jobManager.getJobStats(),
  });
});

// Generate preview (without full processing)
app.post("/api/preview", async (c) => {
  try {
    const formData = await c.req.formData();
    const videoFile = formData.get("video") as File | null;
    const videoUrl = formData.get("videoUrl") as string | null;
    const targetLanguage = formData.get("targetLanguage") as string;
    const optionsStr = formData.get("options") as string;
    const previewAtSeconds = formData.get("previewAtSeconds") as string;

    // Require either file or URL
    if (!videoFile && !videoUrl) {
      return c.json(
        {
          success: false,
          error: "Either video file or videoUrl is required",
        },
        400
      );
    }

    if (videoFile && videoUrl) {
      return c.json(
        {
          success: false,
          error: "Provide either video file or videoUrl, not both",
        },
        400
      );
    }

    if (!targetLanguage) {
      return c.json(
        {
          success: false,
          error: "targetLanguage is required",
        },
        400
      );
    }

    // Save temp file
    const tempId = `preview_${Date.now()}`;
    const videoPath = path.join(uploadsDir, `${tempId}.mp4`);

    // Handle video file upload
    if (videoFile) {
      const buffer = await videoFile.arrayBuffer();
      await fs.writeFile(videoPath, Buffer.from(buffer));
    }
    // Handle video URL
    else if (videoUrl) {
      try {
        await downloadVideoFromUrl(videoUrl, videoPath);
      } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 400);
      }
    }

    // Parse options
    let options: any = {};
    if (optionsStr) {
      options = JSON.parse(optionsStr);
    }
    if (previewAtSeconds) {
      options.previewAtSeconds = Number(previewAtSeconds);
    }

    try {
      // Generate preview
      const { previewPath } = await previewVideoAss(
        videoPath,
        targetLanguage,
        options
      );
      const img = await fs.readFile(previewPath);

      // Clean up temp files
      await fs.unlink(videoPath).catch(() => {});
      await fs.unlink(previewPath).catch(() => {});

      return new Response(img, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      // Clean up on error
      await fs.unlink(videoPath).catch(() => {});
      throw error;
    }
  } catch (error) {
    console.error("❌ Preview error:", error);
    return c.json(
      {
        success: false,
        error: (error as Error).message,
      },
      500
    );
  }
});

// Download processed video
app.get("/api/download/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = jobManager.getJob(jobId);

  if (!job) {
    return c.json({ success: false, error: "Job not found" }, 404);
  }

  if (job.status !== "completed" || !job.outputPath) {
    return c.json(
      {
        success: false,
        error: "Video not ready. Current status: " + job.status,
      },
      400
    );
  }

  try {
    const videoBuffer = await fs.readFile(job.outputPath);
    const filename = `translated_${jobId}.mp4`;

    return new Response(videoBuffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(videoBuffer.length),
      },
    });
  } catch (error) {
    console.error("❌ Download error:", error);
    return c.json(
      {
        success: false,
        error: "File not found or has been deleted",
      },
      404
    );
  }
});

// Get preview image for a job
app.get("/api/preview/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = jobManager.getJob(jobId);

  if (!job || !job.previewPath) {
    return c.json({ success: false, error: "Preview not available" }, 404);
  }

  try {
    const img = await fs.readFile(job.previewPath);
    return new Response(img, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    return c.json({ success: false, error: "Preview not found" }, 404);
  }
});

// API stats
app.get("/api/stats", (c) => {
  return c.json({
    success: true,
    stats: jobManager.getJobStats(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// ===== LEGACY CURL ENDPOINTS (backward compatibility) =====

// Legacy translate-ass endpoint (works with curl)
app.post("/translate-ass", async (c) => {
  try {
    const { targetLanguage, options } = await c.req.json();
    if (!targetLanguage) {
      return c.json(
        { success: false, error: "targetLanguage is required" },
        400
      );
    }
    console.log(`🎬 Starting translation to ${targetLanguage} (ASS)...`);
    const result = await translateVideoAss(
      "./video.mp4",
      targetLanguage as string,
      options
    );
    return c.json({
      success: true,
      message: "Video translated successfully (ASS)!",
      ...result,
    });
  } catch (error) {
    console.error("❌ Translation error (ASS):", (error as Error).message);
    return c.json(
      {
        success: false,
        error: (error as Error).message,
        stack:
          process.env.NODE_ENV === "development"
            ? (error as Error).stack
            : undefined,
      },
      500
    );
  }
});

// Legacy preview-ass endpoint (works with curl)
app.post("/preview-ass", async (c) => {
  try {
    const { targetLanguage, options } = await c.req.json();
    if (!targetLanguage) {
      return c.json(
        { success: false, error: "targetLanguage is required" },
        400
      );
    }
    console.log(`🖼️  Generating preview for ${targetLanguage} (ASS)...`);
    const { previewPath } = await previewVideoAss(
      "./video.mp4",
      targetLanguage as string,
      options
    );
    const img = await fs.readFile(previewPath);
    return new Response(img, { headers: { "Content-Type": "image/png" } });
  } catch (error) {
    console.error("❌ Preview error (ASS):", (error as Error).message);
    return c.json(
      {
        success: false,
        error: (error as Error).message,
        stack:
          process.env.NODE_ENV === "development"
            ? (error as Error).stack
            : undefined,
      },
      500
    );
  }
});

// Background job processor
async function processVideoJob(
  jobId: string,
  videoPath: string,
  targetLanguage: string,
  options: any
) {
  const startTime = Date.now();

  try {
    // Set status to processing
    jobManager.setJobProcessing(jobId);

    // Process video with progress updates
    const result = await translateVideoAss(videoPath, targetLanguage, options);

    // Calculate processing time
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2) + "s";

    // Update job as completed
    jobManager.setJobCompleted(jobId, result.outputPath, result.workDir, {
      ...result.stats,
      processingTime,
    });

    console.log(`✅ Job ${jobId} completed in ${processingTime}`);
  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error);
    jobManager.setJobFailed(jobId, (error as Error).message);
    throw error;
  }
}

export default app;
