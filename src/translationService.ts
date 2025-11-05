import OpenAI from "openai";
import dotenv from "dotenv";
import type { TranslationMap } from "./types.js";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseek = deepseekApiKey
  ? new OpenAI({
      apiKey: deepseekApiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    })
  : null;

const OPENAI_MODEL = process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini";
const DEEPSEEK_MODEL =
  process.env.DEEPSEEK_TRANSLATION_MODEL || "deepseek-chat";
const DEBUG_TRANSLATION = process.env.DEBUG_TRANSLATION === "1";

function pickProvider(targetLanguage: string): "deepseek" | "openai" {
  const lang = targetLanguage.toLowerCase();
  const isZh = lang.includes("chinese") || lang.includes("中文") || lang.startsWith("zh");
  if (isZh && deepseek) return "deepseek";
  return "openai";
}

/**
 * Get language-specific translation instructions
 */
function getLanguageSpecificInstructions(targetLanguage: string): string {
  const lang = targetLanguage.toLowerCase();

  if (lang.includes("chinese") || lang.includes("中文") || lang === "zh") {
    return `

Chinese-specific instructions:
- Use simplified Chinese characters (简体中文) unless specified otherwise.
- Adapt sentence structure to natural Chinese grammar (Subject-Time-Place-Verb-Object).
- Use appropriate measure words (量词) when needed.
- Keep translations concise - Chinese can convey meaning in fewer characters than English.
- Use modern, colloquial expressions where appropriate for video content.
- Avoid literal word-for-word translation; prioritize natural flow and meaning.
- For action instructions (e.g., "Compress", "Hold"), use concise verb forms.
- Example good translations:
  * "Phase 1" → "第一阶段" (not "阶段一")
  * "Look back" → "回看" (not "看回来")
  * "Hold position" → "保持姿势" (not "保持位置")`;
  }
  if (lang.includes("japanese") || lang.includes("日本語") || lang === "ja") {
    return `

Japanese-specific instructions:
- Use natural Japanese sentence structure and particles (は、が、を、に、で).
- Use appropriate politeness levels (casual for sports/action content).
- Keep kanji usage balanced with hiragana for readability.
- Use katakana for foreign loanwords appropriately.`;
  }

  if (lang.includes("korean") || lang.includes("한국어") || lang === "ko") {
    return `

Korean-specific instructions:
- Use appropriate honorific levels (반말 for casual content).
- Follow Korean sentence structure (Subject-Object-Verb).
- Use Hangul primarily, with Hanja sparingly for clarity.`;
  }

  if (lang.includes("spanish") || lang.includes("español") || lang === "es") {
    return `

Spanish-specific instructions:
- Use neutral Latin American Spanish unless European Spanish is specified.
- Maintain proper gender agreement (masculine/feminine).
- Use natural contractions and colloquial expressions for video content.`;
  }

  return ""; // No specific instructions for other languages
}

export async function translateSequence(
  texts: string[],
  targetLanguage: string
): Promise<TranslationMap> {
  if (!Array.isArray(texts) || texts.length === 0) return {};
  try {
    const languageInstructions =
      getLanguageSpecificInstructions(targetLanguage);
    const numbered = texts
      .map((t, i) => ({ index: i + 1, text: t }))
      .filter((x) => (x.text || "").trim().length > 0);
    const prompt = `You are a professional subtitle/localization translator specializing in educational, step-based video content.
You are given an ordered sequence of on-screen English lines. Translate them into natural, readable ${targetLanguage} suitable for bottom-center subtitles.

Rules:
- Keep meaning and intent; do not translate brand names.
- Preserve numbers, times, and units as-is.
- If a line represents a step or enumerated item, preserve numbering and adapt to natural ${targetLanguage} style.
- Prefer concise, actionable phrasing suitable for instructional subtitles.
- Prefer consistent terminology across the entire sequence.
- If a line is meaningless noise, return the original.
${languageInstructions}

Return ONLY a valid JSON object mapping each original string to its translation: { "<original>": "<translated>" }.

Sequence:\n${JSON.stringify(numbered)}`;

    const provider = pickProvider(targetLanguage);
    const client = provider === "deepseek" ? deepseek! : openai;
    const model = provider === "deepseek" ? DEEPSEEK_MODEL : OPENAI_MODEL;
    if (DEBUG_TRANSLATION) {
      try {
        console.log(`   [debug] provider: ${provider}, model: ${model}`);
      } catch {}
    }
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON with original text as keys and translations as values. No extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 3000,
    });

    const content = response.choices[0].message.content!;
    if (DEBUG_TRANSLATION) {
      console.log(
        "   [debug] sequence translation raw length:",
        content.length
      );
      console.log(
        "   [debug] sequence translation snippet:",
        content.slice(0, 300)
      );
    }

    let translationMap: TranslationMap;
    try {
      translationMap = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) translationMap = JSON.parse(match[0]);
      else throw new Error("Invalid JSON response from OpenAI");
    }
    for (const t of texts) {
      if (!(t in translationMap) || !translationMap[t]) translationMap[t] = t;
    }
    return translationMap;
  } catch (error) {
    console.error("Sequence translation error:", (error as Error).message);
    throw new Error(
      `Failed to translate sequence: ${(error as Error).message}`
    );
  }
}

/**
 * Translate texts using OpenAI
 */
export async function translateTexts(
  texts: string[],
  targetLanguage: string
): Promise<TranslationMap> {
  if (texts.length === 0) {
    return {};
  }

  try {
    const languageInstructions =
      getLanguageSpecificInstructions(targetLanguage);

    const prompt = `You are a professional subtitle/localization translator specializing in video content.
Translate the following on-screen English texts into natural, readable ${targetLanguage} suitable for video overlays.

General Rules:
- Keep meaning and intent; do not translate brand names.
- Preserve numbers, times, and units as-is.
- DO NOT translate single symbols like arrows (→, ←, ↑, ↓), bullets (•, ·), or decorative characters.
- Return symbols and single-character decorative elements unchanged.
- Remove or skip emojis, ASCII art, and meaningless character combinations.
- Keep translations concise to fit within the original bounding box.
- If a string is meaningless (e.g., random letters), return the original.
- DO NOT include or translate Arabic, Hebrew, or other non-Latin scripts that appear to be OCR errors.
- Prioritize natural, idiomatic expressions over literal translations.
- Consider the video/sports context when choosing vocabulary.${languageInstructions}

Return ONLY a valid JSON object: { "<original>": "<translated>" } with every input string present as a key.

Example format: {"Hello": "Hola", "World": "Mundo"}

Texts to translate: ${JSON.stringify(texts)}`;

    const provider = pickProvider(targetLanguage);
    const client = provider === "deepseek" ? deepseek! : openai;
    const model = provider === "deepseek" ? DEEPSEEK_MODEL : OPENAI_MODEL;
    if (DEBUG_TRANSLATION) {
      try {
        console.log(`   [debug] provider: ${provider}, model: ${model}`);
      } catch {}
    }
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON with original text as keys and translations as values. No extra text.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const content = response.choices[0].message.content!;

    if (DEBUG_TRANSLATION) {
      console.log("   [debug] translation raw length:", content.length);
      console.log("   [debug] translation snippet:", content.slice(0, 300));
    }

    let translationMap: TranslationMap;
    try {
      translationMap = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        translationMap = JSON.parse(match[0]);
      } else {
        throw new Error("Invalid JSON response from OpenAI");
      }
    }

    for (const t of texts) {
      if (!(t in translationMap) || !translationMap[t]) {
        translationMap[t] = t;
      }
    }

    return translationMap;
  } catch (error) {
    console.error("Translation error:", (error as Error).message);
    throw new Error(`Failed to translate texts: ${(error as Error).message}`);
  }
}
