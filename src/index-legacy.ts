import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { translateVideo } from './videoTranslator.js';
import { translateVideoAss, previewVideoAss } from './subtitleTranslator.js';
import dotenv from 'dotenv';

dotenv.config();

const app = new Hono();

app.get('/', (c) => {
  return c.json({
    status: 'ok',
    message: 'Video Text Translator API',
    endpoints: {
      translate: 'POST /translate',
      translateAss: 'POST /translate-ass',
      previewAss: 'POST /preview-ass',
      health: 'GET /',
    },
  });
});

app.post('/translate-ass', async (c) => {
  try {
    const { targetLanguage, options } = await c.req.json();
    if (!targetLanguage) {
      return c.json({ success: false, error: 'targetLanguage is required' }, 400);
    }
    console.log(`🎬 Starting translation to ${targetLanguage} (ASS)...`);
    const result = await translateVideoAss('./video.mp4', targetLanguage as string, options);
    return c.json({ success: true, message: 'Video translated successfully (ASS)!', ...result });
  } catch (error) {
    console.error('❌ Translation error (ASS):', (error as Error).message);
    return c.json({
      success: false,
      error: (error as Error).message,
      stack: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined,
    }, 500);
  }
});

// Preview a single-frame PNG with the same ASS styling
app.post('/preview-ass', async (c) => {
  try {
    const { targetLanguage, options } = await c.req.json();
    if (!targetLanguage) {
      return c.json({ success: false, error: 'targetLanguage is required' }, 400);
    }
    console.log(`🖼️  Generating preview for ${targetLanguage} (ASS)...`);
    const { previewPath } = await previewVideoAss('./video.mp4', targetLanguage as string, options);
    const img = await (await import('fs')).promises.readFile(previewPath);
    return new Response(img, { headers: { 'Content-Type': 'image/png' } });
  } catch (error) {
    console.error('❌ Preview error (ASS):', (error as Error).message);
    return c.json({
      success: false,
      error: (error as Error).message,
      stack: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined,
    }, 500);
  }
});

app.post('/translate', async (c) => {
  try {
    const { targetLanguage } = await c.req.json();
    if (!targetLanguage) {
      return c.json({ success: false, error: 'targetLanguage is required' }, 400);
    }

    console.log(`🎬 Starting translation to ${targetLanguage}...`);
    const result = await translateVideo('./video.mp4', targetLanguage);

    return c.json({
      success: true,
      message: 'Video translated successfully!',
      ...result,
    });
  } catch (error) {
    console.error('❌ Translation error:', (error as Error).message);
    return c.json({
      success: false,
      error: (error as Error).message,
      stack: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined,
    }, 500);
  }
});

const port = Number(process.env.PORT) || 3000;

console.log(`🚀 Video Translator API starting on port ${port}...`);
console.log(`📝 Make sure you have:`);
console.log(`   - video.mp4 in the project root`);
console.log(`   - .env file with API keys`);
console.log(`   - FFmpeg installed on your system`);
console.log('');

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`✅ Server running at http://localhost:${info.port}`);
  console.log('');
  console.log('📖 Usage:');
  console.log(`   curl -X POST http://localhost:${port}/translate \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"targetLanguage": "Chinese"}'`);
  console.log('');
});
