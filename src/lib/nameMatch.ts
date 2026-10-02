/**
 * Does the name a bank returned for an account plausibly belong to this
 * person? Used to keep withdrawals going to the rep's OWN account.
 *
 * Bank names come back uppercased, in any order, often with middle names and
 * sometimes with a title. So: compare word sets, case- and accent-insensitive,
 * and require at least two of the person's name words to appear (or the only
 * one, for a single-word name). Deliberately not fuzzy beyond that — a
 * near-miss goes to support, not through.
 */
const NOISE = new Set(['mr', 'mrs', 'miss', 'ms', 'dr', 'prof', 'engr', 'chief', 'alhaji', 'alhaja']);

function words(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && !NOISE.has(w));
}

export function namesMatch(personName: string, bankAccountName: string): boolean {
  const mine = [...new Set(words(personName))];
  const theirs = new Set(words(bankAccountName));
  if (mine.length === 0 || theirs.size === 0) return false;
  const hits = mine.filter((w) => theirs.has(w)).length;
  return hits >= Math.min(2, mine.length);
}
