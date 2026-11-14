import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Chunk, KbIndex, RetrievalHit, RetrieveOptions } from './types';

/**
 * Portable vector store: the whole index is one JSON file
 * (ai-engineering/rag/index/kb.json). Good enough for a small, curated KB and
 * dependency-free. Supports cosine search (when chunks carry vectors) and a
 * lexical fallback (always available, no embeddings needed) so retrieval is
 * testable offline.
 *
 * PRODUCTION (pgvector): they already run Postgres/Prisma. For scale, store
 * chunks in a table instead of JSON:
 *
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE kb_chunk (
 *     id        text PRIMARY KEY,
 *     text      text NOT NULL,
 *     title     text, source text, category text, updated text, file text, heading text,
 *     embedding vector(1024)            -- match the embedding model's dim
 *   );
 *   CREATE INDEX ON kb_chunk USING hnsw (embedding vector_cosine_ops);
 *
 * Then retrieve with: ORDER BY embedding <=> $queryVec LIMIT k, plus WHERE
 * clauses for metadata filtering. The chunk/metadata shape here maps 1:1.
 */

// ---------------- persistence ----------------

export function saveIndex(path: string, index: KbIndex): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 0));
}

export function loadIndex(path: string): KbIndex {
  if (!existsSync(path)) throw new Error(`KB index not found at ${path}. Run build.ts first.`);
  return JSON.parse(readFileSync(path, 'utf8')) as KbIndex;
}

export function makeIndex(chunks: Chunk[], embedModel: string | null): KbIndex {
  const dim = chunks.find((c) => c.vector)?.vector?.length ?? null;
  return { embedModel, dim, builtAt: new Date().toISOString(), chunks };
}

// ---------------- scoring ----------------

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'at', 'by',
  'it', 'this', 'that', 'be', 'as', 'from', 'how', 'what', 'do', 'does', 'can', 'i', 'my', 'me',
]);

export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9₦\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
}

function matchesFilter(c: Chunk, filter?: RetrieveOptions['filter']): boolean {
  if (!filter) return true;
  const meta = c.metadata as unknown as Record<string, string | undefined>;
  return Object.entries(filter).every(([k, v]) => meta[k] === v);
}

function toHit(c: Chunk, score: number): RetrievalHit {
  return { text: c.text, score, source: c.metadata.source, title: c.metadata.title, category: c.metadata.category, id: c.id };
}

// ---------------- search ----------------

/** Cosine similarity over embedding vectors. Requires a query vector. */
export function vectorSearch(index: KbIndex, queryVec: number[], opts: RetrieveOptions = {}): RetrievalHit[] {
  const k = opts.k ?? 4;
  return index.chunks
    .filter((c) => c.vector && matchesFilter(c, opts.filter))
    .map((c) => toHit(c, cosine(queryVec, c.vector!)))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Lexical fallback — TF scoring with an IDF-ish rarity weight. No embeddings
 * required, so it always works (tests, CI, no-key dev). Not as good as vectors
 * but enough to retrieve the right curated doc for a keyword-ish query.
 */
export function lexicalSearch(index: KbIndex, query: string, opts: RetrieveOptions = {}): RetrievalHit[] {
  const k = opts.k ?? 4;
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];
  const chunks = index.chunks.filter((c) => matchesFilter(c, opts.filter));

  // document frequency per query term, for a light IDF weight
  const df = new Map<string, number>();
  for (const term of new Set(qTerms)) {
    df.set(term, chunks.filter((c) => tokenize(c.text).includes(term)).length || 1);
  }
  const N = chunks.length || 1;

  return chunks
    .map((c) => {
      const terms = tokenize(c.text);
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const q of qTerms) {
        const f = tf.get(q) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + N / (df.get(q) ?? 1));
        score += (f / terms.length) * idf;
      }
      return toHit(c, score);
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
