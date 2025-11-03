import { translateVideo } from './videoTranslator.js';
import dotenv from 'dotenv';

dotenv.config();

async function test(): Promise<void> {
  console.log('🧪 Testing Video Translator...\n');

  try {
    const result = await translateVideo('./video.mp4', 'Chinese');

    console.log('\n📊 Results:');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ Test failed:', (error as Error).message);
    process.exit(1);
  }
}

test();
