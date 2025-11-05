# 🎬 Video Text Translator API - Production Setup

Production-ready video translation API with file uploads, job queue, S3 storage, and database persistence.

## 🚀 Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your configuration
npm run dev
```

## 📋 Features

- ✅ **File Upload**: Multipart form-data support for video uploads
- ✅ **URL Support**: Process videos from URLs (no upload needed)
- ✅ **Async Job Processing**: Non-blocking translation with job queue
- ✅ **Job Status Polling**: Real-time progress updates
- ✅ **Cloud Storage**: S3 / Cloudflare R2 support
- ✅ **Database Persistence**: PostgreSQL / SQLite / In-Memory
- ✅ **Preview Generation**: Test subtitle styles before processing
- ✅ **Backward Compatible**: Works with existing curl commands

## 🔧 Configuration

### Storage Options

**Local Storage** (default - no setup required):
```env
STORAGE_TYPE=local
```

**AWS S3**:
```env
STORAGE_TYPE=s3
S3_BUCKET=my-video-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
```

**Cloudflare R2**:
```env
STORAGE_TYPE=r2
S3_BUCKET=my-video-bucket
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
```

### Database Options

**In-Memory** (default - no persistence):
```env
DB_TYPE=memory
```

**PostgreSQL** (recommended for production):
```bash
# Install PostgreSQL client
npm install pg

# Configure
DB_TYPE=postgres
DATABASE_URL=postgresql://user:password@localhost:5432/videotranslator
```

**SQLite** (good for development):
```bash
# Install SQLite
npm install better-sqlite3

# Configure
DB_TYPE=sqlite
SQLITE_PATH=./jobs.db
```

## 📡 API Endpoints

### Production Endpoints

#### `POST /api/upload`
Upload video and start translation job.

**Option 1: Upload video file**
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@my-video.mp4" \
  -F "targetLanguage=Chinese" \
  -F 'options={"baseFontSize":72,"roundedRadius":20,"bgBlur":5}'
```

**Option 2: Provide video URL**
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "videoUrl=https://example.com/video.mp4" \
  -F "targetLanguage=Chinese" \
  -F 'options={"baseFontSize":72,"roundedRadius":20,"bgBlur":5}'
```

Response:
```json
{
  "success": true,
  "jobId": "job_1234567890_abc123",
  "status": "queued",
  "message": "Video uploaded successfully. Processing started."
}
```

#### `GET /api/jobs/:id`
Check job status and progress.

```bash
curl http://localhost:3000/api/jobs/job_1234567890_abc123
```

Response:
```json
{
  "success": true,
  "job": {
    "id": "job_1234567890_abc123",
    "status": "processing",
    "progress": 65,
    "targetLanguage": "Chinese",
    "createdAt": 1234567890,
    "updatedAt": 1234567895,
    "hasOutput": false,
    "hasPreview": false
  }
}
```

Status values: `queued` | `processing` | `completed` | `failed`

#### `GET /api/download/:jobId`
Download the translated video.

```bash
curl http://localhost:3000/api/download/job_1234567890_abc123 \
  -o translated_video.mp4
```

#### `POST /api/preview`
Generate a preview image with subtitle styling.

**Option 1: Upload video file**
```bash
curl -X POST http://localhost:3000/api/preview \
  -F "video=@my-video.mp4" \
  -F "targetLanguage=Chinese" \
  -F 'options={"baseFontSize":72,"roundedRadius":20,"bgBlur":5}' \
  -F "previewAtSeconds=5" \
  -o preview.png
```

**Option 2: Provide video URL**
```bash
curl -X POST http://localhost:3000/api/preview \
  -F "videoUrl=https://example.com/video.mp4" \
  -F "targetLanguage=Chinese" \
  -F 'options={"baseFontSize":72,"roundedRadius":20,"bgBlur":5}' \
  -F "previewAtSeconds=5" \
  -o preview.png
```

### Legacy Endpoints (Backward Compatible)

#### `POST /translate-ass`
Process `video.mp4` in project root (original behavior).

```bash
curl -X POST http://localhost:3000/translate-ass \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "Chinese",
    "options": {
      "baseFontSize": 72,
      "roundedRadius": 20,
      "bgBlur": 5
    }
  }'
```

#### `POST /preview-ass`
Generate preview from `video.mp4` in project root.

```bash
curl -X POST http://localhost:3000/preview-ass \
  -H "Content-Type: application/json" \
  -o preview.png \
  -d '{
    "targetLanguage": "Chinese",
    "options": {
      "roundedRadius": 20,
      "bgBlur": 5,
      "previewAtSeconds": 5
    }
  }'
```

## 🎨 Subtitle Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseFontSize` | number | `44` | Font size in pixels |
| `boxPad` | number | `10` | Padding around text |
| `marginV` | number | `90` | Distance from bottom |
| `textColorHex` | string | `#FFFFFF` | Text color (#RRGGBB or #RRGGBBAA) |
| `bgColorHex` | string | `#00000080` | Background color |
| `roundedRadius` | number | `0` | Corner radius for rounded rectangles |
| `bgBlur` | number | `0` | Blur amount for soft edges |
| `forceOneLine` | boolean | `false` | Force single-line text |
| `fontUrl` | string | `""` | URL to custom font file |
| `fontName` | string | `""` | Font family name |
| `previewAtSeconds` | number | `0` | Timestamp for preview (preview only) |

## 🌐 Frontend Integration Example

```html
<!DOCTYPE html>
<html>
<body>
  <h2>Upload Video File</h2>
  <input type="file" id="videoFile" accept="video/*">

  <h2>Or Provide Video URL</h2>
  <input type="text" id="videoUrl" placeholder="https://example.com/video.mp4" style="width:400px">

  <h2>Translation Settings</h2>
  <select id="language">
    <option value="Chinese">Chinese</option>
    <option value="Spanish">Spanish</option>
    <option value="French">French</option>
  </select>
  <button onclick="uploadVideo()">Translate</button>
  <div id="status"></div>
  <video id="result" controls style="display:none"></video>

  <script>
    async function uploadVideo() {
      const file = document.getElementById('videoFile').files[0];
      const videoUrl = document.getElementById('videoUrl').value.trim();
      const language = document.getElementById('language').value;

      // Validate input
      if (!file && !videoUrl) {
        alert('Please provide either a video file or URL');
        return;
      }

      if (file && videoUrl) {
        alert('Please provide either a file or URL, not both');
        return;
      }

      const formData = new FormData();

      // Add file or URL
      if (file) {
        formData.append('video', file);
      } else {
        formData.append('videoUrl', videoUrl);
      }

      formData.append('targetLanguage', language);
      formData.append('options', JSON.stringify({
        baseFontSize: 72,
        roundedRadius: 20,
        bgBlur: 5,
        bgColorHex: '#00000099'
      }));

      // Upload
      const uploadRes = await fetch('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData
      });
      const { jobId } = await uploadRes.json();

      // Poll for status
      const statusDiv = document.getElementById('status');
      const interval = setInterval(async () => {
        const statusRes = await fetch(`http://localhost:3000/api/jobs/${jobId}`);
        const { job } = await statusRes.json();

        statusDiv.textContent = `Status: ${job.status} (${job.progress}%)`;

        if (job.status === 'completed') {
          clearInterval(interval);
          document.getElementById('result').src =
            `http://localhost:3000/api/download/${jobId}`;
          document.getElementById('result').style.display = 'block';
        } else if (job.status === 'failed') {
          clearInterval(interval);
          statusDiv.textContent = `Error: ${job.error}`;
        }
      }, 2000);
    }
  </script>
</body>
</html>
```

## 📦 Deployment

### Docker Compose (Recommended)

The project includes a production-ready `docker-compose.yml` with PostgreSQL database.

**Quick Start:**
```bash
# 1. Clone repository
git clone your-repo-url
cd video-translator

# 2. Create .env file
cp .env.example .env
nano .env  # Add your API keys

# 3. Start services
docker-compose up -d

# 4. Check logs
docker-compose logs -f app

# 5. Stop services
docker-compose down
```

**Environment Variables (.env):**
```bash
# Required
GOOGLE_VISION_API_KEY=your_key
OPENAI_API_KEY=your_key

# Database (auto-configured for docker-compose)
DB_USER=videotranslator
DB_PASSWORD=your_secure_password
DB_NAME=videotranslator

# Optional: S3 Storage
STORAGE_TYPE=local  # or s3/r2
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=your_key
S3_SECRET_ACCESS_KEY=your_secret

# Optional: Server
PORT=3000
CORS_ORIGIN=https://yourdomain.com
```

### Coolify Deployment

[Coolify](https://coolify.io) provides easy Docker deployment with built-in SSL, monitoring, and backups.

**Step 1: Prepare Repository**
- Push your code to GitHub/GitLab/Gitea
- Ensure `Dockerfile` and `docker-compose.yml` are in root

**Step 2: Create New Resource in Coolify**
1. Go to your Coolify dashboard
2. Click "New Resource" → "Docker Compose"
3. Connect your Git repository
4. Select branch (e.g., `main`)

**Step 3: Configure Environment Variables**
Add these environment variables in Coolify:
```bash
GOOGLE_VISION_API_KEY=your_google_key
OPENAI_API_KEY=your_openai_key
DB_USER=videotranslator
DB_PASSWORD=generate_secure_password_here
DB_NAME=videotranslator
NODE_ENV=production
CORS_ORIGIN=https://yourdomain.com

# Optional: For S3/R2 Storage
STORAGE_TYPE=s3
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your_key
S3_SECRET_ACCESS_KEY=your_secret
```

**Step 4: Configure Domains**
- Add your domain in Coolify settings
- Coolify automatically provisions SSL certificates via Let's Encrypt
- Point your domain DNS to Coolify server IP

**Step 5: Deploy**
- Click "Deploy" button
- Coolify will:
  - Pull latest code from Git
  - Build Docker image
  - Start PostgreSQL database
  - Start application container
  - Configure reverse proxy with SSL

**Step 6: Health Monitoring**
- Coolify monitors container health via healthcheck
- Auto-restarts on failure
- View logs in real-time from dashboard

**Persistent Data:**
Coolify automatically handles volumes:
- `postgres_data` - Database persistence
- `uploads_data` - Video files
- `temp_data` - Temporary processing files

**Updating:**
1. Push changes to Git
2. Click "Redeploy" in Coolify
3. Zero-downtime rolling update

### Docker Only (Manual)

Build and run manually:
```bash
docker build -t video-translator .
docker run -p 3000:3000 \
  -e GOOGLE_VISION_API_KEY=your_key \
  -e OPENAI_API_KEY=your_key \
  -e DB_TYPE=memory \
  video-translator
```

### Railway / Render

1. Push to GitHub
2. Connect your repository
3. Add environment variables
4. Set build command: `npm install`
5. Set start command: `npm start`
6. Deploy! 🚀

### AWS EC2 / DigitalOcean

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y nodejs npm ffmpeg postgresql

# Clone and setup
git clone your-repo
cd video-translator
npm install
cp .env.example .env
# Edit .env

# Run with PM2
npm install -g pm2
pm2 start npm --name "video-translator" -- start
pm2 save
pm2 startup
```

## 🔒 Security Recommendations

1. **API Authentication**: Add API keys or JWT tokens
2. **Rate Limiting**: Implement rate limiting per IP/user
3. **File Size Limits**: Already set to 100MB (adjust as needed)
4. **CORS**: Set specific origins in production
5. **HTTPS**: Use reverse proxy (nginx/Caddy) with SSL
6. **Environment Variables**: Never commit `.env` files
7. **S3 Bucket Policy**: Restrict public access
8. **Database**: Use connection pooling and read replicas

## 📊 Monitoring

```bash
# Get API stats
curl http://localhost:3000/api/stats

# List all jobs
curl http://localhost:3000/api/jobs
```

## 🐛 Troubleshooting

**Jobs not persisting after restart**:
- Set `DB_TYPE=sqlite` or `DB_TYPE=postgres` instead of `memory`

**S3 upload fails**:
- Verify S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY
- Check bucket permissions and CORS settings
- For R2, ensure S3_ENDPOINT is set correctly

**Database connection errors**:
- Install required package: `npm install pg` or `npm install better-sqlite3`
- Verify DATABASE_URL format
- Check database server is running

**Out of memory**:
- Increase Node.js memory: `node --max-old-space-size=4096 dist/index.js`
- Enable swap space on server
- Use Redis for job queue (future enhancement)

## 💰 Cost Estimate

Per 30-second video:
- **Google Vision OCR**: $0.03-0.05
- **OpenAI GPT-4o-mini**: $0.001-0.01
- **S3 Storage**: $0.023/GB/month
- **Database**: Free (SQLite) or $0.01-0.10/month (RDS micro)
- **Total per video**: ~$0.04-0.06

## 📝 License

MIT

---

**Made with ❤️**
