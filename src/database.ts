import dotenv from 'dotenv';
import type { Job } from './jobManager.js';

dotenv.config();

const DB_TYPE = process.env.DB_TYPE || 'memory'; // 'memory' | 'postgres' | 'mysql' | 'sqlite'

export interface DatabaseProvider {
  saveJob(job: Job): Promise<void>;
  getJob(id: string): Promise<Job | null>;
  updateJob(id: string, updates: Partial<Job>): Promise<void>;
  getAllJobs(): Promise<Job[]>;
  deleteJob(id: string): Promise<void>;
  cleanup(olderThan: number): Promise<number>;
}

// In-memory database (default, no persistence)
class MemoryDatabase implements DatabaseProvider {
  private jobs: Map<string, Job> = new Map();

  async saveJob(job: Job): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async getJob(id: string): Promise<Job | null> {
    return this.jobs.get(id) || null;
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      Object.assign(job, updates);
      this.jobs.set(id, job);
    }
  }

  async getAllJobs(): Promise<Job[]> {
    return Array.from(this.jobs.values());
  }

  async deleteJob(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async cleanup(olderThan: number): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (now - job.updatedAt > olderThan) {
        this.jobs.delete(id);
        count++;
      }
    }
    return count;
  }
}

// PostgreSQL database
class PostgresDatabase implements DatabaseProvider {
  private pool: any;

  constructor() {
    this.initializePool();
  }

  private async initializePool() {
    try {
      const { Pool } = await import('pg');
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      });

      // Create table if not exists
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS jobs (
          id VARCHAR(255) PRIMARY KEY,
          status VARCHAR(50) NOT NULL,
          target_language VARCHAR(100) NOT NULL,
          options JSONB,
          video_path TEXT,
          output_path TEXT,
          preview_path TEXT,
          progress INTEGER DEFAULT 0,
          error TEXT,
          stats JSONB,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);

      // Create index for faster queries
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)
      `);
    } catch (error) {
      console.error('Failed to initialize PostgreSQL. Install pg package.');
      throw error;
    }
  }

  async saveJob(job: Job): Promise<void> {
    await this.pool.query(
      `INSERT INTO jobs (id, status, target_language, options, video_path, output_path, preview_path, progress, error, stats, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         status = $2, options = $4, video_path = $5, output_path = $6, preview_path = $7,
         progress = $8, error = $9, stats = $10, updated_at = $12`,
      [
        job.id,
        job.status,
        job.targetLanguage,
        JSON.stringify(job.options),
        job.videoPath,
        job.outputPath,
        job.previewPath,
        job.progress,
        job.error,
        JSON.stringify(job.stats),
        job.createdAt,
        job.updatedAt,
      ]
    );
  }

  async getJob(id: string): Promise<Job | null> {
    const result = await this.pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      status: row.status,
      targetLanguage: row.target_language,
      options: row.options,
      videoPath: row.video_path,
      outputPath: row.output_path,
      previewPath: row.preview_path,
      progress: row.progress,
      error: row.error,
      stats: row.stats,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    const job = await this.getJob(id);
    if (!job) return;

    Object.assign(job, updates, { updatedAt: Date.now() });
    await this.saveJob(job);
  }

  async getAllJobs(): Promise<Job[]> {
    const result = await this.pool.query('SELECT * FROM jobs ORDER BY created_at DESC');
    return result.rows.map((row: any) => ({
      id: row.id,
      status: row.status,
      targetLanguage: row.target_language,
      options: row.options,
      videoPath: row.video_path,
      outputPath: row.output_path,
      previewPath: row.preview_path,
      progress: row.progress,
      error: row.error,
      stats: row.stats,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async deleteJob(id: string): Promise<void> {
    await this.pool.query('DELETE FROM jobs WHERE id = $1', [id]);
  }

  async cleanup(olderThan: number): Promise<number> {
    const cutoff = Date.now() - olderThan;
    const result = await this.pool.query(
      'DELETE FROM jobs WHERE updated_at < $1 RETURNING id',
      [cutoff]
    );
    return result.rowCount;
  }
}

// SQLite database (good for development/small deployments)
class SQLiteDatabase implements DatabaseProvider {
  private db: any;

  constructor() {
    this.initializeDatabase();
  }

  private async initializeDatabase() {
    try {
      const sqlite3 = await import('better-sqlite3');
      const Database = sqlite3.default;
      this.db = new Database(process.env.SQLITE_PATH || './jobs.db');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          target_language TEXT NOT NULL,
          options TEXT,
          video_path TEXT,
          output_path TEXT,
          preview_path TEXT,
          progress INTEGER DEFAULT 0,
          error TEXT,
          stats TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
    } catch (error) {
      console.error('Failed to initialize SQLite. Install better-sqlite3 package.');
      throw error;
    }
  }

  async saveJob(job: Job): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO jobs (id, status, target_language, options, video_path, output_path, preview_path, progress, error, stats, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      job.id,
      job.status,
      job.targetLanguage,
      JSON.stringify(job.options),
      job.videoPath,
      job.outputPath,
      job.previewPath,
      job.progress,
      job.error,
      JSON.stringify(job.stats),
      job.createdAt,
      job.updatedAt
    );
  }

  async getJob(id: string): Promise<Job | null> {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id);

    if (!row) return null;

    return {
      id: row.id,
      status: row.status,
      targetLanguage: row.target_language,
      options: JSON.parse(row.options || '{}'),
      videoPath: row.video_path,
      outputPath: row.output_path,
      previewPath: row.preview_path,
      progress: row.progress,
      error: row.error,
      stats: JSON.parse(row.stats || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    const job = await this.getJob(id);
    if (!job) return;

    Object.assign(job, updates, { updatedAt: Date.now() });
    await this.saveJob(job);
  }

  async getAllJobs(): Promise<Job[]> {
    const stmt = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC');
    const rows = stmt.all();

    return rows.map((row: any) => ({
      id: row.id,
      status: row.status,
      targetLanguage: row.target_language,
      options: JSON.parse(row.options || '{}'),
      videoPath: row.video_path,
      outputPath: row.output_path,
      previewPath: row.preview_path,
      progress: row.progress,
      error: row.error,
      stats: JSON.parse(row.stats || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async deleteJob(id: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM jobs WHERE id = ?');
    stmt.run(id);
  }

  async cleanup(olderThan: number): Promise<number> {
    const cutoff = Date.now() - olderThan;
    const stmt = this.db.prepare('DELETE FROM jobs WHERE updated_at < ?');
    const result = stmt.run(cutoff);
    return result.changes;
  }
}

// Factory function
export function getDatabaseProvider(): DatabaseProvider {
  switch (DB_TYPE) {
    case 'postgres':
      return new PostgresDatabase();
    case 'sqlite':
      return new SQLiteDatabase();
    case 'memory':
    default:
      return new MemoryDatabase();
  }
}

// Singleton instance
export const database = getDatabaseProvider();
