import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Storage configuration
const STORAGE_TYPE = process.env.STORAGE_TYPE || 'local'; // 'local' | 's3' | 'r2'

export interface StorageProvider {
  upload(filePath: string, key: string): Promise<string>;
  download(key: string, destPath: string): Promise<void>;
  getUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

// Local filesystem storage
class LocalStorage implements StorageProvider {
  private baseDir: string;

  constructor() {
    this.baseDir = path.join(process.cwd(), 'uploads');
  }

  async upload(filePath: string, key: string): Promise<string> {
    const destPath = path.join(this.baseDir, key);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(filePath, destPath);
    return key;
  }

  async download(key: string, destPath: string): Promise<void> {
    const sourcePath = path.join(this.baseDir, key);
    await fs.copyFile(sourcePath, destPath);
  }

  async getUrl(key: string): Promise<string> {
    // For local storage, return a relative path
    return `/uploads/${key}`;
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.baseDir, key);
    await fs.unlink(filePath).catch(() => {});
  }
}

// AWS S3 / Cloudflare R2 storage
class S3Storage implements StorageProvider {
  private s3Client: any;
  private bucket: string;
  private region: string;
  private endpoint?: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET || '';
    this.region = process.env.S3_REGION || 'us-east-1';
    this.endpoint = process.env.S3_ENDPOINT; // For R2 or custom endpoints

    if (!this.bucket) {
      throw new Error('S3_BUCKET environment variable is required for S3 storage');
    }

    // Lazy load AWS SDK to avoid requiring it when using local storage
    this.initializeS3Client();
  }

  private async initializeS3Client() {
    try {
      // Dynamic import of AWS SDK
      const AWS = await import('@aws-sdk/client-s3');
      const { S3Client } = AWS;

      const config: any = {
        region: this.region,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        },
      };

      if (this.endpoint) {
        config.endpoint = this.endpoint;
        config.forcePathStyle = true; // Required for R2
      }

      this.s3Client = new S3Client(config);
    } catch (error) {
      console.error('Failed to initialize S3 client. Install @aws-sdk/client-s3');
      throw error;
    }
  }

  async upload(filePath: string, key: string): Promise<string> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const fileContent = await fs.readFile(filePath);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fileContent,
      ContentType: this.getContentType(key),
    });

    await this.s3Client.send(command);
    return key;
  }

  async download(key: string, destPath: string): Promise<void> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.s3Client.send(command);
    const stream = response.Body as any;

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    await fs.writeFile(destPath, buffer);
  }

  async getUrl(key: string): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    // Generate presigned URL valid for 1 hour
    const url = await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    return url;
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.s3Client.send(command);
  }

  private getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const types: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.webm': 'video/webm',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
    };
    return types[ext] || 'application/octet-stream';
  }
}

// Factory function to get the appropriate storage provider
export function getStorageProvider(): StorageProvider {
  switch (STORAGE_TYPE) {
    case 's3':
    case 'r2':
      return new S3Storage();
    case 'local':
    default:
      return new LocalStorage();
  }
}

// Singleton instance
export const storage = getStorageProvider();
