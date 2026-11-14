import type { Chunk, ChunkMetadata } from './types';

/**
 * Deterministic Markdown chunker. Pure — no network, no clock.
 *
 * Splits a knowledge doc by `##` section headings, then packs sections into
 * chunks of a target size (~500-800 tokens) with a small overlap so a fact that
 * straddles a boundary is still retrievable. Frontmatter is parsed into
 * metadata and carried on every chunk. Chunk ids are `${file}#${n}`, stable
 * across rebuilds as long as the document is unchanged.
 */

// Rough token estimate without a tokenizer: ~0.75 tokens per word is a common
// English approximation; we invert it to words. Target 500-800 tokens.
const TARGET_TOKENS = 650;
const MAX_TOKENS = 800;
const OVERLAP_TOKENS = 80;
const WORDS_PER_TOKEN = 0.75;

const toWords = (tokens: number) => Math.round(tokens / WORDS_PER_TOKEN);
const TARGET_WORDS = toWords(TARGET_TOKENS);
const MAX_WORDS = toWords(MAX_TOKENS);
const OVERLAP_WORDS = toWords(OVERLAP_TOKENS);

export interface ParsedDoc {
  frontmatter: Record<string, string>;
  body: string;
}

/** Parse simple `key: value` YAML frontmatter delimited by `---` lines. */
export function parseFrontmatter(raw: string): ParsedDoc {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw.trim() };
  const frontmatter: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) frontmatter[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return { frontmatter, body: (m[2] ?? '').trim() };
}

interface Section {
  heading?: string;
  text: string;
}

/** Split a markdown body into sections at `#`/`##`/`###` headings. */
function splitSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let heading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1]!.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Split an over-long section into word-bounded windows with overlap. */
function windowize(text: string): string[] {
  const words = text.split(/\s+/);
  if (words.length <= MAX_WORDS) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const end = Math.min(i + TARGET_WORDS, words.length);
    out.push(words.slice(i, end).join(' '));
    if (end >= words.length) break;
    i = end - OVERLAP_WORDS; // step back for overlap
  }
  return out;
}

/**
 * Chunk one knowledge document.
 * @param raw   full file contents (frontmatter + markdown)
 * @param file  the filename, used for stable ids and metadata
 */
export function chunkDocument(raw: string, file: string): Chunk[] {
  const { frontmatter, body } = parseFrontmatter(raw);
  const baseMeta: Omit<ChunkMetadata, 'heading'> = {
    title: frontmatter.title ?? file,
    source: frontmatter.source ?? 'unknown',
    category: frontmatter.category ?? 'general',
    updated: frontmatter.updated ?? 'unknown',
    file,
  };

  const sections = splitSections(body);
  const chunks: Chunk[] = [];
  let packed = '';
  let packedHeading: string | undefined;

  const emit = (text: string, heading?: string) => {
    const t = text.trim();
    if (!t) return;
    chunks.push({
      id: `${file}#${chunks.length}`,
      text: heading ? `## ${heading}\n${t}` : t,
      metadata: { ...baseMeta, heading },
    });
  };

  for (const sec of sections) {
    const windows = windowize(sec.text);
    for (const w of windows) {
      // If adding this window would blow the target, flush what we have.
      if (packed && wordCount(packed) + wordCount(w) > TARGET_WORDS) {
        emit(packed, packedHeading);
        packed = '';
        packedHeading = undefined;
      }
      if (!packed) packedHeading = sec.heading;
      packed = packed ? `${packed}\n\n${w}` : w;
      // A single window already at/over max → emit immediately.
      if (wordCount(packed) >= MAX_WORDS) {
        emit(packed, packedHeading);
        packed = '';
        packedHeading = undefined;
      }
    }
  }
  emit(packed, packedHeading);
  return chunks;
}
