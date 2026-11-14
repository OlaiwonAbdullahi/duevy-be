import { describe, it, expect, vi, beforeEach } from 'vitest';

// The date arithmetic itself is covered exhaustively in dates.test.ts. Here we
// check the *integration*: a relative phrase passed to create_due is resolved
// deterministically before the backend is called, and the confirm-first gate
// still holds. We mock the internal API so no network/db is touched.
const apiCall = vi.fn();
vi.mock('./api', () => ({ apiCall: (...a: unknown[]) => apiCall(...a) }));

import { findTool } from './tools';
import type { ToolContext } from './tools';

const ctx: ToolContext = {
  rep: { userId: 'u1', name: 'Ada', role: 'user', spaces: [{ id: 'sp1', name: 'CSC', short: 'CSC', repRole: 'lead' }] },
  token: 'jwt',
  getActiveSpaceId: () => 'sp1',
  setActiveSpaceId: () => {},
};

describe('create_due date integration', () => {
  beforeEach(() => apiCall.mockReset());

  it('resolves a relative phrase and gates on confirmation (no backend call yet)', async () => {
    const tool = findTool('create_due')!;
    const res = (await tool.run(
      { title: 'Dept due', amount_naira: 2000, due_date: 'next Friday', category: 'departmental_due' },
      ctx,
    )) as { needsConfirmation?: boolean; summary?: { dueDate: string } };
    expect(res.needsConfirmation).toBe(true);
    expect(res.summary?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // resolved, not the raw phrase
    expect(apiCall).not.toHaveBeenCalled();
  });

  it('rejects an unparseable date with a helpful message, not a backend call', async () => {
    const tool = findTool('create_due')!;
    const res = (await tool.run(
      { title: 'X', amount_naira: 1000, due_date: 'whenever abeg', category: 'other', confirmed: true },
      ctx,
    )) as { error?: string };
    expect(res.error).toMatch(/date/i);
    expect(apiCall).not.toHaveBeenCalled();
  });

  it('calls the backend once confirmed, with the resolved YYYY-MM-DD', async () => {
    apiCall.mockResolvedValue({ ok: true, data: { id: 'due1' } });
    const tool = findTool('create_due')!;
    await tool.run(
      { title: 'Dept due', amount_naira: 2000, due_date: '2026-12-01', category: 'departmental_due', confirmed: true },
      ctx,
    );
    expect(apiCall).toHaveBeenCalledOnce();
    const body = apiCall.mock.calls[0]![0].body;
    expect(body.dueDate).toBe('2026-12-01');
    expect(body.amount).toBe(200000); // naira → kobo
  });
});
