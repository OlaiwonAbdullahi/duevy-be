import { join } from 'path';
import type { KbIndex, RetrievalHit, RetrieveOptions } from './types';
import { loadIndex, vectorSearch, lexicalSearch } from './store';
import { embed, hasEmbeddingKey } from './embed';

/**
 * Retrieve the most relevant knowledge chunks for a query, with source
 * attribution. Uses vector search when the index has embeddings AND a key is
 * available; otherwise falls back to lexical search (no network). Never
 * fabricates — if the KB has nothing relevant, it returns an empty list.
 */

export const DEFAULT_INDEX_PATH = join(__dirname, '..', 'index', 'kb.json');

let cached: { path: string; index: KbIndex } | null = null;
function getIndex(path: string): KbIndex {
  if (cached && cached.path === path) return cached.index;
  const index = loadIndex(path);
  cached = { path, index };
  return index;
}

export interface RetrieveConfig extends RetrieveOptions {
  indexPath?: string;
}

export async function retrieve(query: string, cfg: RetrieveConfig = {}): Promise<RetrievalHit[]> {
  const index = getIndex(cfg.indexPath ?? DEFAULT_INDEX_PATH);
  const opts: RetrieveOptions = { k: cfg.k ?? 4, filter: cfg.filter };

  const canVector = index.dim !== null && index.chunks.some((c) => c.vector) && hasEmbeddingKey();
  if (canVector) {
    const [qVec] = await embed([query], 'query');
    if (qVec) return vectorSearch(index, qVec, opts);
  }
  return lexicalSearch(index, query, opts);
}

/** Search directly over an in-memory index (used by tests and callers that already hold one). */
export async function retrieveFrom(index: KbIndex, query: string, opts: RetrieveOptions = {}): Promise<RetrievalHit[]> {
  const canVector = index.dim !== null && index.chunks.some((c) => c.vector) && hasEmbeddingKey();
  if (canVector) {
    const [qVec] = await embed([query], 'query');
    if (qVec) return vectorSearch(index, qVec, opts);
  }
  return lexicalSearch(index, query, opts);
}
