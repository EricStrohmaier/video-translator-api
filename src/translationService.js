import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEBUG_TRANSLATION = process.env.DEBUG_TRANSLATION === '1';

/**
 * Translate texts using OpenAI
 * @param {Array<string>} texts - Array of texts to translate
 * @param {string} targetLanguage - Target language
 * @returns {Promise<Object>} Translation map (original -> translated)
 */
export async function translateTexts(texts, targetLanguage) {
  if (texts.length === 0) {
    return {};
  }

  try {
    const prompt = `You are a professional subtitle/localization translator.
Translate the following on-screen English texts into natural, readable ${targetLanguage} suitable for video overlays.

Rules:
- Keep meaning and intent; do not translate brand names.
- Preserve numbers, times, and units as-is.
- Remove decorative characters, emojis, and ASCII art.
- Keep translations concise to fit within the original bounding box.
- If a string is meaningless (e.g., random letters), return the original.

Return ONLY a valid JSON object: { "<original>": "<translated>" } with every input string present as a key.

Example format: {"Hello": "Hola", "World": "Mundo"}

Texts to translate: ${JSON.stringify(texts)}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Return only valid JSON with original text as keys and translations as values. No extra text.`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const content = response.choices[0].message.content;

    // Clean up markdown code blocks if present
    const cleanContent = content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    if (DEBUG_TRANSLATION) {
      console.log("   [debug] translation raw length:", content?.length ?? 0);
      console.log("   [debug] translation snippet:", cleanContent.slice(0, 300));
    }

    let translationMap;
    try {
      translationMap = JSON.parse(cleanContent);
    } catch (e) {
      // Fallback: attempt to extract JSON substring
      const match = cleanContent.match(/\{[\s\S]*\}/);
      if (match) {
        translationMap = JSON.parse(match[0]);
      } else {
        throw e;
      }
    }

    // Ensure all inputs exist; fallback to original string if missing/empty
    for (const t of texts) {
      if (!Object.prototype.hasOwnProperty.call(translationMap, t) || !translationMap[t]) {
        translationMap[t] = t;
      }
    }

    return translationMap;
  } catch (error) {
    console.error("Translation error:", error);
    throw new Error(`Failed to translate texts: ${error.message}`);
  }
}
