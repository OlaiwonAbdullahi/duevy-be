import { describe, expect, it } from 'vitest';
import { isCurrentSpaceAccountName, randomSuffix, SPACE_ACCOUNT_NAME_MAX, spaceAccountName } from './spaceAccountName';

describe('space account names', () => {
  it('is "<space name>-<3 consonants>"', () => {
    for (let i = 0; i < 200; i++) expect(randomSuffix()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{3}$/);
    expect(spaceAccountName('Computer Science Department', 'KTP')).toBe('Computer Science Department-KTP');
  });

  it('tidies spaces and always fits 9jaPay with the suffix', () => {
    expect(spaceAccountName('  Computer   Science  ', 'KTP')).toBe('Computer Science-KTP');
    const long = spaceAccountName('Department of Electronic and Electrical Engineering Students', 'KTP');
    expect(long.length).toBeLessThanOrEqual(SPACE_ACCOUNT_NAME_MAX);
    expect(long.endsWith('-KTP')).toBe(true);
  });

  it("recognises a bank name already in the form for the space's current name", () => {
    expect(isCurrentSpaceAccountName('DUEVY/Computer Science Department-KTP', 'Computer Science Department')).toBe(true);
    expect(isCurrentSpaceAccountName('DUEVY/COMPUTER SCIENCE DEPARTMENT-KTP', 'Computer Science Department')).toBe(true);
    // Before the suffix, or after the space was renamed, or a name that merely ends in a dash-word.
    expect(isCurrentSpaceAccountName('DUEVY/Computer Science Department', 'Computer Science Department')).toBe(false);
    expect(isCurrentSpaceAccountName('DUEVY/Computer Science-KTP', 'Computer Science Department')).toBe(false);
    expect(isCurrentSpaceAccountName('DUEVY/Faculty of Arts-Ade', 'Faculty of Arts')).toBe(false);
    expect(isCurrentSpaceAccountName(null, 'Physics')).toBe(false);
    // Regex characters in a space name are literal.
    expect(isCurrentSpaceAccountName('DUEVY/C++ (Club)-KTP', 'C++ (Club)')).toBe(true);
  });
});
