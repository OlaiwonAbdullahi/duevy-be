import { env } from '../../config/env';
import { type ConversationTurn } from '../../types/assistant';
import { type LLMAdapter, LLMRequestError, LLMTimeoutError } from './types';

/** Talks to a local/dev Ollama instance running Gemma. */
export class OllamaAdapter implements LLMAdapter {
  async complete(systemPrompt: string, turns: ConversationTurn[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

    try {
      const res = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: env.OLLAMA_MODEL,
          stream: false,
          format: 'json',
          messages: [{ role: 'system', content: systemPrompt }, ...turns],
        }),
      });

      if (!res.ok) {
        throw new LLMRequestError(`Ollama responded ${res.status}`);
      }

      const body = (await res.json()) as { message?: { content?: string } };
      return body.message?.content ?? '';
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
