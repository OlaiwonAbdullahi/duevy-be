import { describe, expect, it } from 'vitest';
import { computeKrediSignature, verifyKrediSignature } from './signature';

const SECRET = 'kredi_secret_current';
const OLD = 'kredi_secret_previous';

// Shapes from the Kredi docs (Collection and Payout webhooks).
const collection = {
  merchantRef: 'DVY-7KQ2-MN4X',
  amount: '5095.00',
  amountReceived: '5095.00',
  status: 'successful',
  remitReference: '012345678908876947351690000040183',
  accountType: 'collection',
};
const payout = {
  krediReference: 'KRDM_99980491533b',
  merchantReference: 'WD-2026-7KQ2MN',
  transactionAmount: 19880,
  transactionStatus: { code: 200, status_message: 'Successful' },
};
const raw = (o: unknown) => Buffer.from(JSON.stringify(o));

describe('verifyKrediSignature', () => {
  it('accepts a collection signed over amount-secret-remitReference', () => {
    const sig = computeKrediSignature('5095.00', SECRET, collection.remitReference);
    expect(verifyKrediSignature(raw(collection), { 'signature-key': sig }, [SECRET]).ok).toBe(true);
  });

  it('accepts a payout signed over transactionAmount-secret-merchantReference', () => {
    const sig = computeKrediSignature('19880', SECRET, payout.merchantReference);
    expect(verifyKrediSignature(raw(payout), { 'signature-key': sig }, [SECRET]).ok).toBe(true);
  });

  it('accepts either rendering of the amount ("5095.00" or "5095")', () => {
    const sig = computeKrediSignature('5095', SECRET, collection.remitReference);
    expect(verifyKrediSignature(raw(collection), { 'signature-key': sig }, [SECRET]).ok).toBe(true);
    const payoutSig = computeKrediSignature('19880.00', SECRET, payout.merchantReference);
    expect(verifyKrediSignature(raw(payout), { 'signature-key': payoutSig }, [SECRET]).ok).toBe(true);
  });

  it('accepts the plain `signature` header and upper-case hex', () => {
    const sig = computeKrediSignature('5095.00', SECRET, collection.remitReference).toUpperCase();
    expect(verifyKrediSignature(raw(collection), { signature: sig }, [SECRET]).ok).toBe(true);
  });

  it('accepts the previous secret during a rotation, and only while held', () => {
    const sig = computeKrediSignature('5095.00', OLD, collection.remitReference);
    expect(verifyKrediSignature(raw(collection), { 'signature-key': sig }, [SECRET, OLD]).ok).toBe(true);
    expect(verifyKrediSignature(raw(collection), { 'signature-key': sig }, [SECRET]).ok).toBe(false);
  });

  it('rejects a changed amount or reference', () => {
    const sig = computeKrediSignature('5095.00', SECRET, collection.remitReference);
    expect(verifyKrediSignature(raw({ ...collection, amount: '9999.00', amountReceived: '9999.00' }), { 'signature-key': sig }, [SECRET])).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyKrediSignature(raw({ ...collection, remitReference: '1' }), { 'signature-key': sig }, [SECRET]).ok).toBe(false);
  });

  it('rejects a missing header, a missing secret, and a body that is not JSON', () => {
    expect(verifyKrediSignature(raw(collection), {}, [SECRET]).reason).toBe('missing');
    expect(verifyKrediSignature(raw(collection), { 'signature-key': 'ab' }, []).reason).toBe('missing');
    expect(verifyKrediSignature(Buffer.from('nope'), { 'signature-key': 'ab' }, [SECRET]).reason).toBe('malformed');
  });
});
