import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPhoneCode, DiditError, normaliseNigerianPhone, sendPhoneCode, verifyIdNumber } from './didit';

function reply(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

afterEach(() => vi.restoreAllMocks());

describe('normaliseNigerianPhone', () => {
  it('accepts local, 234 and +234 forms', () => {
    expect(normaliseNigerianPhone('08012345678')).toBe('+2348012345678');
    expect(normaliseNigerianPhone('2348012345678')).toBe('+2348012345678');
    expect(normaliseNigerianPhone('+234 801 234 5678')).toBe('+2348012345678');
    expect(normaliseNigerianPhone('0701-234-5678')).toBe('+2347012345678');
  });

  it('rejects anything that is not a Nigerian mobile', () => {
    for (const p of ['12345', '+14155552671', '0801234567', '06012345678']) expect(normaliseNigerianPhone(p)).toBeNull();
  });
});

describe('verifyIdNumber', () => {
  const input = { userId: 'u1', kind: 'nin' as const, number: '12345678901', firstName: 'Ada', lastName: 'Obi', dob: '2003-04-05' };

  it('sends the NIN as a Nigerian identification number with consent', async () => {
    const spy = reply(200, { request_id: 'r1', database_validation: { status: 'Approved', match_type: 'full_match' } });
    await expect(verifyIdNumber(input)).resolves.toEqual({ kind: 'nin', outcome: 'approved', requestId: 'r1', matchType: 'full_match', reason: null });
    const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ issuing_state: 'NGA', identification_number: '12345678901', date_of_birth: '2003-04-05', consent: true, vendor_data: 'u1' });
    expect(body.bvn).toBeUndefined();
  });

  it('sends a BVN in its own field', async () => {
    const spy = reply(200, { request_id: 'r9', database_validation: { status: 'Approved', match_type: 'full_match' } });
    await verifyIdNumber({ ...input, kind: 'bvn', number: '22222222221' });
    const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ issuing_state: 'NGA', bvn: '22222222221' });
    expect(body.identification_number).toBeUndefined();
  });

  it('turns a decline into a reason the rep can act on', async () => {
    reply(200, { request_id: 'r2', database_validation: { status: 'Declined', match_type: 'no_match', validations: [{ outcome_code: 'DOCUMENT_NOT_FOUND' }] } });
    await expect(verifyIdNumber(input)).resolves.toMatchObject({ outcome: 'declined', reason: 'No record was found for that NIN' });
    reply(200, { request_id: 'r2', database_validation: { status: 'Declined', match_type: 'no_match', validations: [{ outcome_code: 'NO_MATCH' }] } });
    await expect(verifyIdNumber({ ...input, kind: 'bvn' })).resolves.toMatchObject({ reason: 'The name or date of birth does not match the BVN record' });
  });

  it('treats In Review (registry unavailable) as undecided', async () => {
    reply(200, { request_id: 'r3', database_validation: { status: 'In Review', match_type: null } });
    await expect(verifyIdNumber(input)).resolves.toMatchObject({ outcome: 'in_review', reason: null });
  });

  it('marks 5xx as retryable and 4xx as not', async () => {
    reply(502, { code: 'empty_provider_response' });
    await expect(verifyIdNumber(input)).rejects.toMatchObject({ retryable: true });
    reply(400, { detail: 'bad' });
    await expect(verifyIdNumber(input)).rejects.toBeInstanceOf(DiditError);
    await expect(verifyIdNumber(input)).rejects.toMatchObject({ retryable: false });
  });
});

describe('phone OTP', () => {
  it('treats Success and Retry as sent, Blocked as blocked', async () => {
    reply(200, { status: 'Retry', request_id: 'p1' });
    await expect(sendPhoneCode('u1', '+2348012345678')).resolves.toBe('sent');
    reply(200, { status: 'Blocked', reason: 'repeated_attempts' });
    await expect(sendPhoneCode('u1', '+2348012345678')).resolves.toBe('blocked');
  });

  it('maps check outcomes and refuses duplicate, burner and VoIP numbers', async () => {
    const spy = reply(200, { status: 'Approved' });
    await expect(checkPhoneCode('u1', '+2348012345678', '123456')).resolves.toMatchObject({ outcome: 'approved' });
    expect(JSON.parse(spy.mock.calls[0]![1]!.body as string)).toMatchObject({
      duplicated_phone_number_action: 'DECLINE',
      disposable_number_action: 'DECLINE',
      voip_number_action: 'DECLINE',
    });
    reply(200, { status: 'Failed', message: 'Attempts remaining: 2' });
    await expect(checkPhoneCode('u1', '+2348012345678', '000000')).resolves.toEqual({ outcome: 'wrong_code', message: 'Attempts remaining: 2' });
    reply(200, { status: 'Declined' });
    await expect(checkPhoneCode('u1', '+2348012345678', '000000')).resolves.toMatchObject({ outcome: 'declined' });
    reply(200, { status: 'Expired or Not Found' });
    await expect(checkPhoneCode('u1', '+2348012345678', '000000')).resolves.toMatchObject({ outcome: 'expired' });
  });
});
