import { describe, expect, it } from 'vitest';
import { displayName, ngn, payoutLedgerDescription, payoutSummary, TRANSFER_NARRATION_MAX, transferNarration } from './narration';

describe('the recipient\'s statement: "Duevy/<space code> sent you NGN<amount>"', () => {
  it('reads as asked: code and amount, no reference or space name', () => {
    expect(transferNarration({ spaceCode: 'CSC', amountKobo: 300_000 })).toBe('Duevy/CSC sent you NGN3000');
    // 9jaPay strips "." from narrations, so kobo are spelled out.
    expect(transferNarration({ spaceCode: 'CSC', amountKobo: 300_050 })).toBe('Duevy/CSC sent you NGN3000 and 50 kobo');
    expect(transferNarration({ spaceCode: 'CSC', amountKobo: 98_925 })).toBe('Duevy/CSC sent you NGN989 and 25 kobo');
    expect(transferNarration({ spaceCode: 'FETSAX', amountKobo: 49_999_999 })).toBe('Duevy/FETSAX sent you NGN499999 and 99 kobo');
  });

  it('is plain ASCII and far within 9jaPay\'s 50 characters, whatever the code', () => {
    const n = transferNarration({ spaceCode: 'FETSAX', amountKobo: 50_000_000 });
    expect(n).toBe('Duevy/FETSAX sent you NGN500000');
    expect(Buffer.byteLength(n, 'utf8')).toBe(n.length);
    expect(n.length).toBeLessThanOrEqual(TRANSFER_NARRATION_MAX);
    expect(transferNarration({ spaceCode: 'A/H', amountKobo: 100_000 })).toBe('Duevy/A-H sent you NGN1000');
    expect(transferNarration({ spaceCode: 'ỌYC', amountKobo: 100_000 })).toBe('Duevy/OYC sent you NGN1000');
  });
});

describe('the sender\'s side: "You sent NGN3000 to Abdullahi Olaiwon"', () => {
  const p = { netKobo: 300_000, accountName: 'ABDULLAHI  OLAIWON', accountMasked: 'GTBank •••• 4321' };

  it('names the recipient as people write it, not in the bank\'s capitals', () => {
    expect(displayName('ABDULLAHI  OLAIWON')).toBe('Abdullahi Olaiwon');
    expect(displayName("O'NEIL-OKORO ADA")).toBe("O'Neil-Okoro Ada");
    expect(ngn(300_000)).toBe('NGN3000');
  });

  it('only says "sent" once it has arrived, and only "you" to whoever made it', () => {
    expect(payoutSummary({ ...p, status: 'success' })).toBe('You sent NGN3000 to Abdullahi Olaiwon');
    expect(payoutSummary({ ...p, status: 'success' }, { viewerIsRequester: false })).toBe('NGN3000 was sent to Abdullahi Olaiwon');
    expect(payoutSummary({ ...p, status: 'processing' })).toBe('Sending NGN3000 to Abdullahi Olaiwon');
    expect(payoutSummary({ ...p, status: 'awaiting_approval' })).toBe('NGN3000 to Abdullahi Olaiwon, awaiting approval');
    expect(payoutSummary({ ...p, status: 'failed' })).toBe("Couldn't send NGN3000 to Abdullahi Olaiwon");
    expect(payoutSummary({ ...p, status: 'reversed' })).toBe("Couldn't send NGN3000 to Abdullahi Olaiwon");
  });

  it('falls back to the masked account when the bank gave no name', () => {
    expect(payoutSummary({ ...p, accountName: null, status: 'success' })).toBe('You sent NGN3000 to GTBank •••• 4321');
    expect(payoutLedgerDescription(p)).toBe('Sent NGN3000 to Abdullahi Olaiwon');
  });
});
