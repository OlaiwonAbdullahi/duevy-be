import { retrieve } from './retrieve';

/**
 * `search_knowledge` — an agent tool, shaped exactly like the tools in
 * src/ai/tools.ts (name / description / parameters / async run). It lets the
 * assistant look up CURRENT Duevy facts (fees, rules, KYC, capabilities,
 * glossary, regulation context) from the curated KB instead of relying on
 * fine-tuned memory, and returns ATTRIBUTED snippets so replies can cite a
 * source and never fabricate.
 *
 * HOW TO REGISTER IT IN THE AGENT (do not edit tools.ts from here):
 *   In src/ai/tools.ts, import this and add it to the `tools` array:
 *       import { searchKnowledgeTool } from '../../ai-engineering/rag/src/knowledgeTool';
 *       export const tools: AgentTool[] = [ ...existing, searchKnowledgeTool ];
 *   (or copy this module under src/ for a cleaner import path). The tool's
 *   `run` signature ignores ToolContext, so it drops in unchanged. Then add a
 *   system-prompt line like: "For questions about how Duevy works (fees, rules,
 *   KYC, what you can do), call search_knowledge and answer from the result,
 *   citing the source; do not guess." Note this tool is READ-ONLY and needs no
 *   confirmation gate.
 */

export interface KnowledgeToolResult {
  results: { title: string; source: string; category: string; snippet: string }[];
}

function snippet(text: string, max = 500): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const searchKnowledgeTool = {
  name: 'search_knowledge',
  description:
    'Look up how Duevy works — fees, money units, confirmation/PIN rules, KYC, ' +
    'what the assistant can do, Pidgin/slang meanings, and general Nigerian ' +
    'fintech-regulation context. Returns short, source-attributed snippets. Use ' +
    'this for "how/what/why does Duevy…" questions instead of guessing. It does ' +
    'NOT read live account data (balances, dues, members) — use the account ' +
    'tools for those.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The question or topic to look up.' },
      category: {
        type: 'string',
        description: 'Optional filter: product, finance, security, compliance, language, regulation.',
      },
      k: { type: 'number', description: 'How many snippets to return (default 3).' },
    },
    required: ['query'],
  },
  async run(args: Record<string, unknown>): Promise<KnowledgeToolResult> {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return { results: [] };
    const category = typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined;
    const k = typeof args.k === 'number' && args.k > 0 ? Math.min(args.k, 8) : 3;

    const hits = await retrieve(query, { k, filter: category ? { category } : undefined });
    return {
      results: hits.map((h) => ({ title: h.title, source: h.source, category: h.category, snippet: snippet(h.text) })),
    };
  },
};
