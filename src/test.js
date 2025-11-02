import { translateVideo } from './videoTranslator.js';
import dotenv from 'dotenv';

dotenv.config();

// Simple test script
async function test() {
  console.log('🧪 Testing Video Translator...\n');
  
  try {
    const result = await translateVideo('./video.mp4', 'Chinese');
    
    console.log('\n📊 Results:');
    console.log(JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

test();
