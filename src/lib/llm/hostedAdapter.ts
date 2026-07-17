import { env } from '../../config/env';
import { type ConversationTurn } from '../../types/assistant';
import { type LLMAdapter, LLMRequestError, LLMTimeoutError } from './types';

/**
 * Talks to any OpenAI-chat-completions-compatible hosted endpoint (Gemini API
 * in OpenAI-compat mode, a self-hosted GPU box running vLLM, etc). Swapping
 * LLM_PROVIDER=hosted plus these two env vars is the only change needed to
 * move off local Ollama — handler code never changes.
 */
export class HostedAdapter implements LLMAdapter {
  async complete(systemPrompt: string, turns: ConversationTurn[]): Promise<string> {
    if (!env.LLM_HOSTED_BASE_URL) {
      throw new LLMRequestError('LLM_HOSTED_BASE_URL is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

    try {
      const res = await fetch(`${env.LLM_HOSTED_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.LLM_HOSTED_API_KEY ? { Authorization: `Bearer ${env.LLM_HOSTED_API_KEY}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: env.LLM_HOSTED_MODEL,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: systemPrompt }, ...turns],
        }),
      });

      if (!res.ok) {
        throw new LLMRequestError(`Hosted LLM responded ${res.status}`);
      }

      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content ?? '';
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
