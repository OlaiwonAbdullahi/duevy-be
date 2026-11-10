/**
 * How a transfer reads, on both sides.
 *
 *  - The recipient's bank statement (the transfer's narration, set by us):
 *      "Duevy/CSC sent you NGN3000"
 *  - The sender's side, in Duevy (the withdrawal's summary, the ledger line,
 *    the notification): "You sent NGN3000 to Abdullahi Olaiwon"
 *
 * A transfer carries a single narration that both statements share, so the
 * sender's wording comes from Duevy, not the bank. Amounts are what lands in
 * the recipient's account, in naira, without separators. "NGN" rather than
 * "₦": bank narrations are plain ASCII. Our reference is not in the
 * narration; it travels separately as the transfer's payment reference.
 */

export const TRANSFER_NARRATION_MAX = 50;

/** Plain, single-spaced ASCII: accents stripped, anything else dropped. */
export function plainAscii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 300000 → "NGN3000", 300050 → "NGN3000.50". */
export function ngn(amountKobo: number): string {
  return `NGN${amountKobo % 100 === 0 ? String(amountKobo / 100) : (amountKobo / 100).toFixed(2)}`;
}

/** Banks return account names in capitals: "ABDULLAHI  OLAIWON" → "Abdullahi Olaiwon". */
export function displayName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * An amount as a bank narration can carry it. 9jaPay drops "." from
 * narrations (live, 2026-11-10: "NGN989.25" arrived as "NGN98925"), so kobo
 * are spelled out: 98925 → "NGN989 and 25 kobo". Whole naira as ngn().
 */
export function narrationAmount(amountKobo: number): string {
  const naira = Math.floor(amountKobo / 100);
  const kobo = amountKobo % 100;
  return kobo === 0 ? `NGN${naira}` : `NGN${naira} and ${kobo} kobo`;
}

/** The recipient's statement: "Duevy/CSC sent you NGN3000". Always well under 9jaPay's 50 characters. */
export function transferNarration(input: { spaceCode: string; amountKobo: number }): string {
  // "/" separates the parts, so it can't appear inside the code.
  const code = plainAscii(input.spaceCode).replace(/\//g, '-');
  return `Duevy/${code} sent you ${narrationAmount(input.amountKobo)}`.slice(0, TRANSFER_NARRATION_MAX);
}

/** Who the money went to, as the sender reads it: the bank's account name, else the masked account. */
function recipientOf(p: { accountName: string | null; accountMasked: string }): string {
  return p.accountName ? displayName(p.accountName) : p.accountMasked;
}

type PayoutLike = { netKobo: number; accountName: string | null; accountMasked: string; status: string };

/**
 * The sender's line for a withdrawal, true to its state: "You sent NGN3000 to
 * Abdullahi Olaiwon" only once it has arrived; while on its way, "Sending …";
 * if it didn't go through, "Couldn't send …".
 */
export function payoutSummary(p: PayoutLike, opts: { viewerIsRequester?: boolean } = { viewerIsRequester: true }): string {
  const amount = ngn(p.netKobo);
  const who = recipientOf(p);
  const you = opts.viewerIsRequester !== false;
  switch (p.status) {
    case 'success':
      return you ? `You sent ${amount} to ${who}` : `${amount} was sent to ${who}`;
    case 'failed':
    case 'reversed':
    case 'cancelled':
      return `Couldn't send ${amount} to ${who}`;
    case 'awaiting_approval':
      return `${amount} to ${who}, awaiting approval`;
    default: // pending, processing
      return you ? `Sending ${amount} to ${who}` : `${amount} on its way to ${who}`;
  }
}

/** The space ledger's line for a withdrawal (written when it's made; a failure adds a reversal). */
export function payoutLedgerDescription(p: { netKobo: number; accountName: string | null; accountMasked: string }): string {
  return `Sent ${ngn(p.netKobo)} to ${recipientOf(p)}`;
}
