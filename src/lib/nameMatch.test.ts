import { describe, expect, it } from 'vitest';
import { namesMatch } from './nameMatch';

describe('namesMatch', () => {
  it('matches a bank name in any order, case, with a middle name', () => {
    expect(namesMatch('Ada Obi', 'OBI ADA CHIOMA')).toBe(true);
    expect(namesMatch('Adébáyọ̀ Ogunlesi', 'OGUNLESI ADEBAYO')).toBe(true);
  });

  it('ignores titles', () => {
    expect(namesMatch('Tunde Bakare', 'MR BAKARE TUNDE')).toBe(true);
  });

  it('rejects a different person sharing one name', () => {
    expect(namesMatch('Ada Obi', 'OBI EMEKA')).toBe(false);
    expect(namesMatch('Ada Obi', 'JOHN DOE')).toBe(false);
  });

  it('handles single-word and empty names', () => {
    expect(namesMatch('Madonna', 'MADONNA CICCONE')).toBe(true);
    expect(namesMatch('', 'ADA OBI')).toBe(false);
  });
});
