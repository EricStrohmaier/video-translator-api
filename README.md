# 🎬 Video Text Translator API

Automatically detect, translate, and overlay text on videos using AI-powered OCR and translation with beautiful ASS subtitles.

## ⚡ Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Add your video
cp /path/to/your/video.mp4 ./video.mp4

# Start the server
npm run dev

# Or run a quick test
npm run test
```

## 📡 API Endpoints

### Production API (recommended)

#### `POST /api/upload`
Translate a video and return a job ID (multipart/form-data). The job can be polled via `/api/jobs/:id` and downloaded via `/api/download/:jobId` when complete.

Request:
```bash
curl -X POST http://localhost:3000/api/upload \
  -F 'videoUrl=https://example.com/clip.mp4' \
  -F 'targetLanguage=Russian' \
  -F 'options={
    "baseFontSize": 46,
    "roundedRadius": 14,
    "bgColorHex": "#000000CC",
    "padX": 8,
    "padTop": 6,
    "padBottom": 12,
    "maxWidthFraction": 0.9
  }'
```

#### `POST /api/preview`
Generate a PNG preview (multipart/form-data). Accepts the same `options` as upload plus `previewAtSeconds`.

Request:
```bash
curl -X POST http://localhost:3000/api/preview \
  -F 'videoUrl=https://example.com/clip.mp4' \
  -F 'targetLanguage=Russian' \
  -F 'previewAtSeconds=7' \
  -F 'options={
    "roundedRadius": 14,
    "padX": 8,
    "padTop": 6,
    "padBottom": 12,
    "bgColorHex": "#000000CC"
  }' \
  -o preview.png
```

### `POST /translate-ass`
Translate video with bottom-center ASS subtitles (recommended).

**Request:**
```bash
curl -X POST http://localhost:3000/translate-ass \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "Chinese",
    "options": {
      "baseFontSize": 72,
      "boxPad": 12,
      "marginV": 90,
      "textColorHex": "#FFFFFF",
      "bgColorHex": "#00000099",
      "roundedRadius": 20,
      "bgBlur": 5,
      "fontUrl": "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
      "fontName": "Noto Sans CJK SC"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Video translated successfully (ASS)!",
  "outputPath": "./temp/job_1234567890/output_translated.mp4",
  "workDir": "./temp/job_1234567890",
  "stats": {
    "framesProcessed": 30,
    "textsDetected": 15,
    "translationsApplied": 12,
    "processingTime": "45.23s"
  }
}
```

### `POST /preview-ass`
Generate a preview PNG with subtitle styling (useful for testing).

**Request:**
```bash
curl -X POST http://localhost:3000/preview-ass \
  -H "Content-Type: application/json" \
  -o preview.png \
  -d '{
    "targetLanguage": "Chinese",
    "options": {
      "baseFontSize": 72,
      "roundedRadius": 20,
      "bgBlur": 5,
      "bgColorHex": "#00000099",
      "previewAtSeconds": 5
    }
  }'
```

**Response:** PNG image file

### `POST /translate`
Translate video with original in-place text overlay (legacy method).

**Request:**
```bash
curl -X POST http://localhost:3000/translate \
  -H "Content-Type: application/json" \
  -d '{"targetLanguage": "Spanish"}'
```

### `GET /`
Health check and API information.

## 🎨 Subtitle Options

All options are **optional** and fall back to `.env` values or defaults.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseFontSize` | number | `44` | Font size in pixels |
| `boxPad` | number | `10` | Padding around text box in pixels |
| `marginV` | number | `90` | Distance from bottom of video in pixels |
| `textColorHex` | string | `#FFFFFF` | Text color in hex format (supports `#RRGGBB` or `#RRGGBBAA`) |
| `bgColorHex` | string | `#00000080` | Background color in hex format (supports `#RRGGBB` or `#RRGGBBAA`) |
| `roundedRadius` | number | `12` | Corner radius for rounded rectangles (0 = sharp corners) |
| `bgBlur` | number | `0` | Blur amount for soft edges in pixels (0 = sharp edges) |
| `forceOneLine` | boolean | `false` | Force text to single line even if long |
| `fontUrl` | string | `""` | Direct URL to .otf/.ttf font file |
| `fontName` | string | `""` | Font family name (e.g., "Noto Sans CJK SC") |
| `cjkWidthFactor` | number | `0.9` | Width estimation factor for CJK characters |
| `latinWidthFactor` | number | `0.62` | Width estimation factor for Latin characters |
| `padX` | number | `~0.75*boxPad` | Horizontal padding (px) for background badge |
| `padTop` | number | `~0.6*boxPad` | Top padding (px) for background badge |
| `padBottom` | number | `boxPad` | Bottom padding (px) for background badge |
| `maxWidthFraction` | number | `0.9` | Max text block width as a fraction of video width (0.5–0.98) |
| `previewAtSeconds` | number | `0` | Timestamp to extract preview frame (preview-ass only) |

**Color Format Notes:**
- `#RRGGBB` - Opaque color (e.g., `#FF0000` = red)
- `#RRGGBBAA` - Color with alpha transparency (e.g., `#00000066` = semi-transparent black)
  - `AA` ranges from `00` (fully transparent) to `FF` (fully opaque)

**Examples:**

```json
// Subtle modern style
{
  "roundedRadius": 10,
  "bgBlur": 3,
  "bgColorHex": "#00000066"
}

// Bold Netflix-style
{
  "baseFontSize": 80,
  "bgColorHex": "#000000CC",
  "roundedRadius": 15
}

// Soft dreamy style
{
  "roundedRadius": 30,
  "bgBlur": 15,
  "bgColorHex": "#00000099"
}
```

## 🌍 Supported Languages

Chinese, Spanish, German, French, Japanese, Korean, Portuguese, Italian, Russian, Arabic, Hindi, and many more!

## ⚙️ Environment Variables

Create a `.env` file with:

```env
# Required
GOOGLE_VISION_API_KEY=AIzaSyC...your_key_here
OPENAI_API_KEY=sk-...your_key_here

# Optional
PORT=3000

# Optional subtitle defaults (can be overridden via API options)
ASS_BASE_FONTSIZE=44
ASS_BOX_PAD=10
ASS_MARGIN_V=90
SUB_TEXT_COLOR=#FFFFFF
SUB_BG_COLOR=#00000080
ASS_FORCE_ONE_LINE=0
ASS_FONT_URL=https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf
ASS_FONT_NAME=Noto Sans CJK SC
CJK_WIDTH_FACTOR=0.9
LATIN_WIDTH_FACTOR=0.62
DEBUG_COMPOSER=0
```

## 🔧 Requirements

- **Node.js** 20+
- **FFmpeg** (for video processing)
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt-get install ffmpeg`
  - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html)

## 🔍 How It Works

```
video.mp4
  ↓
[Extract Frames @ 1fps] → frame_0001.png, frame_0002.png, ...
  ↓
[Google Vision OCR] → Detect text in each frame
  ↓
[Collect Unique Texts] → ["Subscribe", "Like", "Follow"]
  ↓
[OpenAI Translation] → {"Subscribe": "订阅", "Like": "喜欢", ...}
  ↓
[Generate ASS Subtitles] → Bottom-center overlay with custom styling
  ↓
[FFmpeg Render] → output_translated.mp4 ✨
```

## 💰 Cost Estimate

For a typical 30-second video:
- **Google Vision OCR**: ~$0.03-0.05 (30 frames @ $1.50/1000 images)
- **OpenAI GPT-4o-mini**: ~$0.001-0.01 (translation)
- **Total**: ~$0.04-0.06 per video

## 📁 Project Structure

```
src/
  index.ts                 # Hono API server
  subtitleTranslator.ts    # ASS subtitle workflow (main)
  subtitleComposer.ts      # ASS file generation with styling
  videoTranslator.ts       # Legacy in-place overlay
  frameExtractor.ts        # FFmpeg frame extraction
  ocrService.ts            # Google Vision OCR
  translationService.ts    # OpenAI translation
  types.ts                 # TypeScript types
video.mp4                  # Input video (place yours here)
```

## 🐛 Troubleshooting

**FFmpeg not found:**
```bash
ffmpeg -version  # Verify installation
```

**Google Vision API error:**
- Check API key in `.env`
- Enable Vision API in Google Cloud Console
- Ensure billing is enabled (free tier available)

**OpenAI API error:**
- Verify API key in `.env`
- Check account credits and rate limits

**No text detected:**
- Ensure video has visible, high-contrast text
- Try with test video containing clear text first

**Out of memory:**
- Reduce frame rate in `frameExtractor.ts`
- Process shorter clips
- Increase Node memory: `node --max-old-space-size=4096 src/index.ts`

## 📦 Deployment

### Docker

```dockerfile
FROM node:20-slim

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t video-translator .
docker run -p 3000:3000 \
  -e GOOGLE_VISION_API_KEY=your_key \
  -e OPENAI_API_KEY=your_key \
  video-translator
```

### Fly.io / Railway / Render

1. Push to GitHub
2. Connect your hosting platform
3. Add environment variables
4. Deploy! 🚀

## 📝 License

MIT - Do whatever you want with it!

## 🙏 Credits

- [FFmpeg](https://ffmpeg.org/) for video processing
- [Google Cloud Vision](https://cloud.google.com/vision) for OCR
- [OpenAI](https://openai.com/) for translation
- [Hono](https://hono.dev/) for the blazing-fast API framework

---

**Made with ❤️**
