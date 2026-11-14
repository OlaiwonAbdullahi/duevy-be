/** Shared types for the Duevy RAG knowledge base. */

export interface ChunkMetadata {
  title: string;
  source: string;
  category: string;
  updated: string;
  /** The knowledge file this chunk came from, e.g. "fees-and-money.md". */
  file: string;
  /** Section heading this chunk sits under, when known. */
  heading?: string;
}

export interface Chunk {
  /** Stable id: `${file}#${index}` — deterministic across rebuilds. */
  id: string;
  text: string;
  metadata: ChunkMetadata;
  /** Embedding vector; present only when the index was built with a key. */
  vector?: number[];
}

export interface KbIndex {
  /** Embedding model used, or null for a lexical-only index. */
  embedModel: string | null;
  dim: number | null;
  builtAt: string;
  chunks: Chunk[];
}

export interface RetrievalHit {
  text: string;
  score: number;
  source: string;
  title: string;
  category: string;
  id: string;
}

export interface RetrieveOptions {
  k?: number;
  /** Restrict to chunks whose metadata matches (e.g. { category: "finance" }). */
  filter?: Partial<Pick<ChunkMetadata, 'category' | 'source' | 'file'>>;
}
