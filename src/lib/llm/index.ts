import { env } from '../../config/env';
import { ASSISTANT_SYSTEM_PROMPT } from '../../config/assistantPrompt';
import { classificationSchema, type ClassificationResult, type ConversationTurn } from '../../types/assistant';
import { OllamaAdapter } from './ollamaAdapter';
import { HostedAdapter } from './hostedAdapter';
import { type LLMAdapter } from './types';

let adapter: LLMAdapter | undefined;

/** Swappable by LLM_PROVIDER alone — handler code never imports a concrete adapter. */
export function getLLMAdapter(): LLMAdapter {
  if (adapter) return adapter;
  adapter = env.LLM_PROVIDER === 'hosted' ? new HostedAdapter() : new OllamaAdapter();
  return adapter;
}

const UNKNOWN_FALLBACK: ClassificationResult = {
  intent: 'unknown',
  params: null,
  needs_clarification: false,
  clarification_question: null,
  confidence: 0,
  source: 'fallback',
};

/** Strip ```json fences a model sometimes wraps its output in, despite instructions not to. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Calls Gemma, then JSON-schema-validates the output before anything downstream
 * touches it. Malformed or unparseable output falls back to "unknown" rather
 * than ever reaching a handler (§ safety rules — no free-form execution).
 */
export async function classifyIntent(turns: ConversationTurn[]): Promise<ClassificationResult> {
  let raw: string;
  try {
    raw = await getLLMAdapter().complete(ASSISTANT_SYSTEM_PROMPT, turns);
  } catch (err) {
    console.error('[assistant] LLM call failed:', err);
    return UNKNOWN_FALLBACK;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    console.error('[assistant] LLM returned non-JSON output:', raw.slice(0, 200));
    return UNKNOWN_FALLBACK;
  }

  const result = classificationSchema.safeParse(parsed);
  if (!result.success) {
    console.error('[assistant] LLM output failed schema validation:', result.error.errors);
    return UNKNOWN_FALLBACK;
  }

  return { ...result.data, confidence: 0.7, source: 'llm' };
}
