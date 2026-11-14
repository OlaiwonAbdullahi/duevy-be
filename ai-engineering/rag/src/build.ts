import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Chunk } from './types';
import { chunkDocument } from './chunk';
import { makeIndex, saveIndex } from './store';
import { embed, hasEmbeddingKey, EMBED_MODEL } from './embed';

/**
 * Build the KB index: read knowledge/*.md → chunk → embed (if a key is present,
 * else lexical-only) → write index/kb.json.
 *
 * Run:  npx tsx ai-engineering/rag/src/build.ts
 *   with NVIDIA_API_KEY set → vectors are computed (vector + lexical retrieval).
 *   without a key           → lexical-only index (still fully usable offline).
 */

const KNOWLEDGE_DIR = join(__dirname, '..', 'knowledge');
const INDEX_PATH = join(__dirname, '..', 'index', 'kb.json');

export async function build(knowledgeDir = KNOWLEDGE_DIR, indexPath = INDEX_PATH): Promise<void> {
  const files = readdirSync(knowledgeDir).filter((f) => f.endsWith('.md')).sort();
  const chunks: Chunk[] = [];
  for (const file of files) {
    const raw = readFileSync(join(knowledgeDir, file), 'utf8');
    chunks.push(...chunkDocument(raw, file));
  }

  let embedModel: string | null = null;
  if (hasEmbeddingKey()) {
    const vectors = await embed(chunks.map((c) => c.text), 'passage');
    chunks.forEach((c, i) => {
      c.vector = vectors[i];
    });
    embedModel = EMBED_MODEL;
  }

  const index = makeIndex(chunks, embedModel);
  saveIndex(indexPath, index);

  console.log(`Built KB index → ${indexPath}`);
  console.log(`  docs:   ${files.length} (${files.join(', ')})`);
  console.log(`  chunks: ${chunks.length}`);
  console.log(`  embeddings: ${embedModel ? `yes (${embedModel}, dim ${index.dim})` : 'no — lexical-only (set NVIDIA_API_KEY to embed)'}`);
}

// Run when invoked directly (tsx).
if (process.argv[1] && process.argv[1].endsWith('build.ts')) {
  build().catch((err) => {
    console.error('KB build failed:', (err as Error).message);
    process.exit(1);
  });
}
