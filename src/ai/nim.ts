import OpenAI from 'openai';
import { env } from '../config/env';

/**
 * NVIDIA NIM is OpenAI-compatible: we point the OpenAI SDK at NVIDIA's base URL
 * with an NVIDIA key and use chat-completions with tool calling. The model
 * (AI_MODEL, default nvidia/nemotron-3.5-super-vl-120b-a12b) must support function calling.
 *
 * One client per process. Throws if the AI is enabled without a key (env
 * validation already enforces this, so this is only a last-resort guard).
 */

let client: OpenAI | null = null;

export function getNim(): OpenAI {
  if (client) return client;
  if (!env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY is required to use the AI assistant');
  client = new OpenAI({ apiKey: env.NVIDIA_API_KEY, baseURL: env.NVIDIA_BASE_URL });
  return client;
}

export const AI_MODEL = env.AI_MODEL;
