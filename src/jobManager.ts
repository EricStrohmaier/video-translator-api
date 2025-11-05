import fs from 'fs/promises';
import path from 'path';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  targetLanguage: string;
  options?: any;
  videoPath?: string;
  outputPath?: string;
  previewPath?: string;
  progress: number; // 0-100
  error?: string;
  createdAt: number;
  updatedAt: number;
  stats?: {
    framesProcessed?: number;
    textsDetected?: number;
    translationsApplied?: number;
    processingTime?: string;
  };
}

class JobManager {
  private jobs: Map<string, Job> = new Map();
  private maxJobs = 1000; // Limit memory usage
  private jobTTL = 3600000; // 1 hour in milliseconds

  constructor() {
    // Clean up old jobs every 10 minutes
    setInterval(() => this.cleanupOldJobs(), 600000);
  }

  createJob(targetLanguage: string, options?: any): Job {
    const id = this.generateJobId();
    const job: Job = {
      id,
      status: 'queued',
      targetLanguage,
      options,
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.jobs.set(id, job);
    this.enforceMaxJobs();
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, updates: Partial<Job>): void {
    const job = this.jobs.get(id);
    if (job) {
      Object.assign(job, updates, { updatedAt: Date.now() });
      this.jobs.set(id, job);
    }
  }

  setJobProcessing(id: string): void {
    this.updateJob(id, { status: 'processing', progress: 10 });
  }

  setJobCompleted(id: string, outputPath: string, previewPath?: string, stats?: any): void {
    this.updateJob(id, {
      status: 'completed',
      progress: 100,
      outputPath,
      previewPath,
      stats,
    });
  }

  setJobFailed(id: string, error: string): void {
    this.updateJob(id, {
      status: 'failed',
      progress: 0,
      error,
    });
  }

  updateProgress(id: string, progress: number): void {
    this.updateJob(id, { progress: Math.min(100, Math.max(0, progress)) });
  }

  private generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private cleanupOldJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      if (now - job.updatedAt > this.jobTTL) {
        // Clean up files if they exist
        if (job.outputPath) {
          fs.unlink(job.outputPath).catch(() => {});
        }
        if (job.previewPath) {
          fs.unlink(job.previewPath).catch(() => {});
        }
        if (job.videoPath) {
          fs.unlink(job.videoPath).catch(() => {});
        }
        this.jobs.delete(id);
      }
    }
  }

  private enforceMaxJobs(): void {
    if (this.jobs.size > this.maxJobs) {
      // Remove oldest completed or failed jobs first
      const sortedJobs = Array.from(this.jobs.entries())
        .filter(([, job]) => job.status === 'completed' || job.status === 'failed')
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt);

      const toRemove = this.jobs.size - this.maxJobs;
      for (let i = 0; i < toRemove && i < sortedJobs.length; i++) {
        const [id, job] = sortedJobs[i];
        // Clean up files
        if (job.outputPath) fs.unlink(job.outputPath).catch(() => {});
        if (job.previewPath) fs.unlink(job.previewPath).catch(() => {});
        if (job.videoPath) fs.unlink(job.videoPath).catch(() => {});
        this.jobs.delete(id);
      }
    }
  }

  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  getJobStats() {
    const jobs = this.getAllJobs();
    return {
      total: jobs.length,
      queued: jobs.filter(j => j.status === 'queued').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
    };
  }
}

export const jobManager = new JobManager();
