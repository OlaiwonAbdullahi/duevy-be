import { randomInt } from 'crypto';

/**
 * The name on a space's 9jaPay account: "<space name>-<3 letters>", which the
 * bank shows as "DUEVY/<space name>-<3 letters>". The letters make the name
 * unique, so two spaces called "Computer Science Department" (at different
 * schools, or a space recreated after archiving) can't be mistaken for each
 * other on a sender's name enquiry.
 *
 * Consonants only, so the suffix never spells a word; no vowels also removes
 * I/O, the letters most often misread as digits.
 */

/** What we send; 9jaPay adds its own "DUEVY/" in front. */
export const SPACE_ACCOUNT_NAME_MAX = 50;
export const SUFFIX_LENGTH = 3;
const SUFFIX_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

export function randomSuffix(): string {
  let out = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) out += SUFFIX_LETTERS[randomInt(SUFFIX_LETTERS.length)];
  return out;
}

/** The space name, tidied and cut so the suffix always fits. */
export function spaceAccountBase(spaceName: string): string {
  return spaceName
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SPACE_ACCOUNT_NAME_MAX - SUFFIX_LENGTH - 1)
    .trim();
}

export function spaceAccountName(spaceName: string, suffix: string): string {
  return `${spaceAccountBase(spaceName)}-${suffix}`;
}

/**
 * Whether the name the bank shows is already "<anything>/<space name>-<suffix>"
 * for this space's current name (case-insensitive: banks may uppercase).
 */
export function isCurrentSpaceAccountName(shownName: string | null, spaceName: string): boolean {
  if (!shownName) return false;
  const base = spaceAccountBase(spaceName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|/)${base}-[${SUFFIX_LETTERS}]{${SUFFIX_LENGTH}}$`, 'i').test(shownName.trim());
}
