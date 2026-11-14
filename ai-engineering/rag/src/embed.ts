import OpenAI from 'openai';

/**
 * Embeddings via NVIDIA NIM (OpenAI-compatible), mirroring src/ai/nim.ts.
 *
 * Env:
 *   NVIDIA_API_KEY   — required to embed; without it callers fall back to
 *                      lexical search (see retrieve.ts). We never fabricate vectors.
 *   NVIDIA_BASE_URL  — defaults to NVIDIA's hosted endpoint.
 *   EMBED_MODEL      — embedding model id. Default: a NVIDIA retrieval embedding
 *                      model available on build.nvidia.com. Override to match
 *                      whatever your NIM serves.
 */

export const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nvidia/nv-embedqa-e5-v5';
const BASE_URL = process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';

export function hasEmbeddingKey(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY);
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is required to compute embeddings (or use lexical retrieval).');
  client = new OpenAI({ apiKey, baseURL: BASE_URL });
  return client;
}

/**
 * Embed texts, returning one vector per input (order preserved). Batched to keep
 * requests small. `input_type: "passage"` for indexing vs "query" for search —
 * NVIDIA retrieval models use this hint; it's passed through extra body.
 */
export async function embed(texts: string[], inputType: 'passage' | 'query' = 'passage'): Promise<number[][]> {
  if (texts.length === 0) return [];
  const c = getClient();
  const out: number[][] = [];
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const resp = await c.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
      // NVIDIA NIM retrieval models accept an input_type hint via extra body.
      ...( { input_type: inputType } as Record<string, unknown> ),
    } as OpenAI.EmbeddingCreateParams);
    for (const d of resp.data) out[i + d.index] = d.embedding as number[];
  }
  return out;
}
