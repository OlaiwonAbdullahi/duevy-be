import { describe, it, expect } from 'vitest';
import { chunkDocument, parseFrontmatter } from './chunk';
import { makeIndex, lexicalSearch } from './store';
import { retrieveFrom } from './retrieve';
import type { Chunk } from './types';

// These tests run with NO API key — lexical path only (no embeddings, no network).

const SAMPLE_DOC = `---
title: Fees and money units
source: Duevy internal knowledge base
category: finance
updated: 2026-11-14
---

# Money units

Nigerian currency is the naira. 1 naira = 100 kobo. Duevy stores values in kobo.

# Student checkout fee

When a student pays a due, a 1.5% checkout fee is added on top of the amount.
`;

function chunk(id: string, text: string, category: string): Chunk {
  return {
    id,
    text,
    metadata: { title: id, source: 'test', category, updated: '2026-11-14', file: `${id}.md` },
  };
}

describe('chunker', () => {
  it('parses frontmatter into metadata', () => {
    const { frontmatter, body } = parseFrontmatter(SAMPLE_DOC);
    expect(frontmatter.title).toBe('Fees and money units');
    expect(frontmatter.category).toBe('finance');
    expect(body).toContain('Nigerian currency');
    expect(body).not.toContain('---');
  });

  it('splits a doc into chunks that carry frontmatter metadata', () => {
    const chunks = chunkDocument(SAMPLE_DOC, 'fees.md');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      expect(c.metadata.category).toBe('finance');
      expect(c.metadata.source).toBe('Duevy internal knowledge base');
      expect(c.id.startsWith('fees.md#')).toBe(true);
    }
    // the fee fact must survive chunking
    expect(chunks.some((c) => c.text.includes('1.5% checkout fee'))).toBe(true);
  });

  it('produces stable ids across rebuilds', () => {
    const a = chunkDocument(SAMPLE_DOC, 'fees.md').map((c) => c.id);
    const b = chunkDocument(SAMPLE_DOC, 'fees.md').map((c) => c.id);
    expect(a).toEqual(b);
  });
});

describe('lexical retrieval (no embeddings)', () => {
  const chunks = [
    chunk('fees', 'Duevy charges a 1.5% checkout fee when a student pays a due. Amounts are in naira.', 'finance'),
    chunk('kyc', 'A space must pass KYC verification before it can publish a due and collect payments.', 'compliance'),
    chunk('pidgin', 'In Nigerian Pidgin, "those wey never pay" means members with outstanding payments.', 'language'),
  ];
  const index = makeIndex(chunks, null);

  it('returns the right chunk for a keyword query', () => {
    const hits = lexicalSearch(index, 'what is the checkout fee?', { k: 1 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe('fees');
    expect(hits[0]!.source).toBe('test');
  });

  it('retrieves the KYC chunk for a verification query', () => {
    const hits = lexicalSearch(index, 'do I need verification before collecting money?', { k: 2 });
    expect(hits[0]!.id).toBe('kyc');
  });

  it('honours a metadata category filter', () => {
    const hits = lexicalSearch(index, 'pay', { k: 5, filter: { category: 'language' } });
    expect(hits.every((h) => h.category === 'language')).toBe(true);
    expect(hits[0]!.id).toBe('pidgin');
  });

  it('retrieveFrom falls back to lexical with no key', async () => {
    const hits = await retrieveFrom(index, 'checkout fee', { k: 1 });
    expect(hits[0]!.id).toBe('fees');
  });

  it('returns nothing when the KB has no match', () => {
    expect(lexicalSearch(index, 'photosynthesis chlorophyll', { k: 3 })).toEqual([]);
  });
});
