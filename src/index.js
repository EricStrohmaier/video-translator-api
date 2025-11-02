import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { translateVideo } from './videoTranslator.js';
import dotenv from 'dotenv';

dotenv.config();

const app = new Hono();

// Health check
app.get('/', (c) => {
  return c.json({ 
    status: 'ok', 
    message: 'Video Text Translator API',
    endpoints: {
      translate: 'POST /translate',
      health: 'GET /'
    }
  });
});

// Translate video endpoint
app.post('/translate', async (c) => {
  try {
    const { targetLanguage } = await c.req.json();
    
    if (!targetLanguage) {
      return c.json({ 
        success: false, 
        error: 'targetLanguage is required' 
      }, 400);
    }

    console.log(`🎬 Starting translation to ${targetLanguage}...`);
    
    // Process the video (video.mp4 in project root)
    const result = await translateVideo('./video.mp4', targetLanguage);
    
    return c.json({
      success: true,
      message: 'Video translated successfully!',
      ...result
    });
    
  } catch (error) {
    console.error('❌ Translation error:', error);
    return c.json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, 500);
  }
});

// Start server
const port = process.env.PORT || 3000;

console.log(`🚀 Video Translator API starting on port ${port}...`);
console.log(`📝 Make sure you have:`);
console.log(`   - video.mp4 in the project root`);
console.log(`   - .env file with API keys`);
console.log(`   - FFmpeg installed on your system`);
console.log('');

serve({
  fetch: app.fetch,
  port: port
}, (info) => {
  console.log(`✅ Server running at http://localhost:${info.port}`);
  console.log('');
  console.log('📖 Usage:');
  console.log(`   curl -X POST http://localhost:${port}/translate \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"targetLanguage": "Chinese"}'`);
  console.log('');
});
