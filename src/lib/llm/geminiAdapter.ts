import { env } from '../../config/env';
import { type ConversationTurn } from '../../types/assistant';
import { type LLMAdapter, LLMRequestError, LLMTimeoutError } from './types';

/**
 * Talks to Google's Gemini API directly via its native generateContent
 * endpoint — no OpenAI-compatibility shim, no assumptions about which
 * OpenAI-only fields Google's compat layer does or doesn't support.
 */
export class GeminiAdapter implements LLMAdapter {
  async complete(systemPrompt: string, turns: ConversationTurn[]): Promise<string> {
    if (!env.GEMINI_API_KEY) {
      throw new LLMRequestError('GEMINI_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

    try {
      const res = await fetch(
        `${env.GEMINI_BASE_URL}/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: turns.map((t) => ({
              role: t.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: t.content }],
            })),
            generationConfig: { responseMimeType: 'application/json' },
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LLMRequestError(`Gemini responded ${res.status}: ${body.slice(0, 500)}`);
      }

      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      return body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMTimeoutError();
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
