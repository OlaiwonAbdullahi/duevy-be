# Duevy RAG knowledge base

A small, curated retrieval layer so the assistant answers "how does Duevy work?"
questions (fees, rules, KYC, capabilities, Pidgin glossary, regulation context)
from **current, source-attributed facts** instead of fine-tuned memory. It is
separate from the account tools — it never reads live balances/dues/members
(those stay with the backend tools); it serves durable product/policy knowledge.

## Pipeline

```
knowledge/*.md  →  chunk.ts  →  embed.ts (optional)  →  store.ts (index/kb.json)  →  retrieve.ts  →  knowledgeTool.ts (search_knowledge)
```

- **chunk.ts** — deterministic Markdown chunker; splits by heading, packs to
  ~500-800 tokens with overlap, carries frontmatter (`title/source/category/updated`)
  as metadata, stable ids (`file#n`). Pure, no network.
- **embed.ts** — NIM (OpenAI-compatible) embeddings; `EMBED_MODEL` env, default
  `nvidia/nv-embedqa-e5-v5`. Needs `NVIDIA_API_KEY`.
- **store.ts** — JSON vector store with cosine search + **lexical fallback**
  (TF·IDF-ish, no embeddings) + metadata filtering. Maps 1:1 onto Postgres
  **pgvector** for production (schema in the file header).
- **retrieve.ts** — `retrieve(query, {k, filter})`; vector search when the index
  has vectors **and** a key is set, else lexical. Returns attributed hits.
- **knowledgeTool.ts** — the `search_knowledge` agent tool (same shape as
  `src/ai/tools.ts`).

## Build the index

```bash
# Lexical-only (no key needed — fully offline, good for dev/CI):
npx tsx ai-engineering/rag/src/build.ts

# With embeddings (vector retrieval):
NVIDIA_API_KEY=... [EMBED_MODEL=nvidia/nv-embedqa-e5-v5] \
  npx tsx ai-engineering/rag/src/build.ts
```

Writes `index/kb.json`. Without a key it builds a **lexical-only** index — still
fully usable; `retrieve()` just uses lexical scoring. Nothing is fabricated.

## Test

```bash
npx vitest run --config ai-engineering/rag/vitest.config.ts
```

(The root vitest config only includes `src/**`, so the RAG suite ships its own
config. Tests run with no key and no DB — chunking + lexical retrieval.)

## Wire it into the agent

`search_knowledge` is read-only (no confirmation gate). In `src/ai/tools.ts`:

```ts
import { searchKnowledgeTool } from '../../ai-engineering/rag/src/knowledgeTool';
export const tools: AgentTool[] = [ /* …existing… */, searchKnowledgeTool ];
```

(or copy `knowledgeTool.ts`/`retrieve.ts` under `src/` for a cleaner import
path and so it's covered by the main build). Add a system-prompt line such as:
*"For questions about how Duevy works (fees, rules, KYC, what you can do), call
`search_knowledge` and answer from the result, citing the source; don't guess."*
The tool returns attributed snippets so replies cite a source and never fabricate.

## Retrieval & attribution

Every hit carries `title`, `source`, `category` and `id`. The tool returns
`{ results: [{ title, source, category, snippet }] }` — the model should cite the
`source`. If nothing in the KB matches, retrieval returns an empty list (the
model should then say it doesn't have that info, not invent it).

## Keeping knowledge current

The KB is the mechanism for **current** info (vs. stale fine-tuned facts):

1. Edit or add a Markdown file in `knowledge/` (keep the frontmatter).
2. Bump its `updated:` date.
3. Re-run `build.ts`. In production, re-embed only changed files and upsert into
   pgvector by chunk `id`.

## Production (pgvector)

They already run Postgres/Prisma. For scale, replace the JSON store with a
`kb_chunk` table + an `hnsw` cosine index (DDL in `store.ts`'s header). The
chunk/metadata shape maps 1:1; retrieval becomes `ORDER BY embedding <=> $q
LIMIT k` with `WHERE` clauses for metadata filters.

## Scope / honesty note

The seed knowledge is grounded in this codebase. Where exact figures weren't
certain (e.g. the precise withdrawal fee schedule, the specific licensed payment
partner, exact regulatory requirements) the docs say to **retrieve the live
value** rather than stating a fixed number, and the regulation note is marked
**general guidance, not legal advice**.
