import { describe, expect, it } from 'vitest';
import { collectiveLabel, leaderLabel, participantLabel, isJoinable } from './spaceVocab';

describe('spaceVocab', () => {
  it('gives a faculty its own nouns', () => {
    expect(collectiveLabel('faculty')).toBe('faculty');
    expect(leaderLabel('faculty')).toBe('faculty exec');
    expect(participantLabel('faculty')).toBe('payer');
  });

  it('keeps the department/association/club wording as before', () => {
    for (const kind of ['department', 'association', 'club'] as const) {
      expect(leaderLabel(kind)).toBe('rep');
      expect(participantLabel(kind)).toBe('member');
    }
    expect(collectiveLabel('association')).toBe('association');
  });

  it('marks only faculties as not joinable (they collect publicly)', () => {
    expect(isJoinable('faculty')).toBe(false);
    expect(isJoinable('department')).toBe(true);
    expect(isJoinable('association')).toBe(true);
    expect(isJoinable('club')).toBe(true);
  });
});
