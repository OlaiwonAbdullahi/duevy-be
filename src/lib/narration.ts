/**
 * What a recipient sees on their bank statement for a transfer we send:
 *
 *   Duevy/<space code> sent you ₦<amount>
 *   e.g. "Duevy/CSC sent you ₦3000"
 *
 * The amount is what lands in the account, in naira, without separators.
 * Our reference is not in the narration: it travels separately as the
 * transfer's payment reference. 9jaPay refuses narrations over 50
 * characters; with a 2–6 character code this is always far shorter.
 */

export const TRANSFER_NARRATION_MAX = 50;

/** The naira sign: the one character outside plain ASCII a narration may carry. */
export const NAIRA = '₦';

/** Plain, single-spaced text: accents stripped; anything but ASCII and ₦ dropped. */
export function plainText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\x20-\x7E₦]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 300000 → "3000", 300050 → "3000.50". */
function naira(amountKobo: number): string {
  return amountKobo % 100 === 0 ? String(amountKobo / 100) : (amountKobo / 100).toFixed(2);
}

export function transferNarration(input: { spaceCode: string; amountKobo: number }): string {
  // "/" separates the parts, so it can't appear inside the code.
  const code = plainText(input.spaceCode).replace(/[/₦]/g, '-');
  return `Duevy/${code} sent you ${NAIRA}${naira(input.amountKobo)}`.slice(0, TRANSFER_NARRATION_MAX);
}
