import OpenAI from 'openai';
import dotenv from 'dotenv';
import type { TranslationMap } from './types.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const DEBUG_TRANSLATION = process.env.DEBUG_TRANSLATION === '1';

/**
 * Translate texts using OpenAI
 */
export async function translateTexts(texts: string[], targetLanguage: string): Promise<TranslationMap> {
  if (texts.length === 0) {
    return {};
  }

  try {
    const prompt = `You are a professional subtitle/localization translator.
Translate the following on-screen English texts into natural, readable ${targetLanguage} suitable for video overlays.

Rules:
- Keep meaning and intent; do not translate brand names.
- Preserve numbers, times, and units as-is.
- DO NOT translate single symbols like arrows (→, ←, ↑, ↓), bullets (•, ·), or decorative characters.
- Return symbols and single-character decorative elements unchanged.
- Remove or skip emojis, ASCII art, and meaningless character combinations.
- Keep translations concise to fit within the original bounding box.
- If a string is meaningless (e.g., random letters), return the original.
- DO NOT include or translate Arabic, Hebrew, or other non-Latin scripts that appear to be OCR errors.

Return ONLY a valid JSON object: { "<original>": "<translated>" } with every input string present as a key.

Example format: {"Hello": "Hola", "World": "Mundo", "→": "→"}

Texts to translate: ${JSON.stringify(texts)}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Return only valid JSON with original text as keys and translations as values. No extra text.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const content = response.choices[0].message.content!;

    if (DEBUG_TRANSLATION) {
      console.log('   [debug] translation raw length:', content.length);
      console.log('   [debug] translation snippet:', content.slice(0, 300));
    }

    let translationMap: TranslationMap;
    try {
      translationMap = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        translationMap = JSON.parse(match[0]);
      } else {
        throw new Error('Invalid JSON response from OpenAI');
      }
    }

    for (const t of texts) {
      if (!(t in translationMap) || !translationMap[t]) {
        translationMap[t] = t;
      }
    }

    return translationMap;
  } catch (error) {
    console.error('Translation error:', (error as Error).message);
    throw new Error(`Failed to translate texts: ${(error as Error).message}`);
  }
}
