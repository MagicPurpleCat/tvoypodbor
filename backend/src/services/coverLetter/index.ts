import { config } from '../../config.js';
import { openaiCompatProvider } from './openaiCompat.js';
import { templateProvider } from './template.js';
import type { CoverLetterInput } from './types.js';

export type { Resume, Tone } from './types.js';

const llmConfigured = config.LLM_PROVIDER === 'openai_compat' && config.LLM_BASE_URL && config.LLM_API_KEY && config.LLM_MODEL;

/** LLM, если настроен; при любой ошибке LLM — шаблон, чтобы пользователь не остался без отклика. */
export async function generateCoverLetter(input: CoverLetterInput) {
  if (llmConfigured) {
    try {
      return { text: await openaiCompatProvider.generate(input), provider: openaiCompatProvider.name };
    } catch (e) {
      console.error('LLM failed, falling back to template:', (e as Error).message);
    }
  }
  return { text: await templateProvider.generate(input), provider: templateProvider.name };
}
