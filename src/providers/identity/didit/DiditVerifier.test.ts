import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiditVerifier } from './DiditVerifier';
import { ProviderError } from '../../payment/types';

function stubDidit(status: number, body: unknown) {
  const calls: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

const didit = () => new DiditVerifier({ baseUrl: 'https://verification.didit.me', apiKey: 'sk_test_x', phoneChannel: 'sms', bvnServiceId: 'nga_bvn' });

afterEach(() => vi.unstubAllGlobals());

describe('DiditVerifier — phone', () => {
  it('sends a 6-digit code over the configured channel', async () => {
    const calls = stubDidit(200, { request_id: 'r1', status: 'Success' });
    expect(await didit().sendPhoneCode({ phone: '+2348012345678', vendorData: 'u1', ip: '1.2.3.4' })).toBe('sent');
    expect(calls[0]).toMatchObject({
      path: '/v3/phone/send/',
      body: { phone_number: '+2348012345678', options: { code_size: 6, preferred_channel: 'sms' }, vendor_data: 'u1', signals: { ip: '1.2.3.4' } },
      headers: { 'x-api-key': 'sk_test_x' },
    });
  });

  it('reports an anti-fraud refusal or an unusable number as blocked', async () => {
    stubDidit(200, { status: 'Blocked', reason: 'repeated_attempts' });
    expect(await didit().sendPhoneCode({ phone: '+2348012345678', vendorData: 'u1' })).toBe('blocked');
    stubDidit(400, { detail: 'Invalid phone line type provided.' });
    expect(await didit().sendPhoneCode({ phone: '+2348012345678', vendorData: 'u1' })).toBe('blocked');
  });

  it('declines VoIP and disposable numbers when checking the code', async () => {
    const calls = stubDidit(200, { status: 'Approved', phone: { full_number: '+2348012345678' } });
    expect(await didit().checkPhoneCode('+2348012345678', '123456')).toMatchObject({ outcome: 'approved', phone: '+2348012345678' });
    expect(calls[0]!.body).toMatchObject({ voip_number_action: 'DECLINE', disposable_number_action: 'DECLINE' });
  });

  it('maps wrong, declined and expired codes', async () => {
    stubDidit(200, { status: 'Failed', message: 'The verification code is incorrect. Attempts remaining: 2' });
    expect((await didit().checkPhoneCode('+2348012345678', '000000')).outcome).toBe('wrong_code');
    stubDidit(200, { status: 'Declined', message: 'Maximum attempts reached.' });
    expect((await didit().checkPhoneCode('+2348012345678', '000000')).outcome).toBe('declined');
    stubDidit(200, { status: 'Expired or Not Found' });
    expect((await didit().checkPhoneCode('+2348012345678', '000000')).outcome).toBe('expired');
  });

  it('treats a provider outage as retryable, not as the rep’s fault', async () => {
    stubDidit(502, { code: 'phone_provider_unavailable' });
    const err = await didit().sendPhoneCode({ phone: '+2348012345678', vendorData: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });
});

describe('DiditVerifier — BVN', () => {
  const input = { bvn: '12345678901', firstName: 'Ada', lastName: 'Obi', dob: '2003-04-05', vendorData: 'u1' };

  it('sends an NGA database validation with consent and the pinned service', async () => {
    const calls = stubDidit(200, {
      request_id: 'dv_1',
      database_validation: { status: 'Approved', match_type: 'full_match', validations: [{ validation: { full_name: 'full_match', date_of_birth: 'full_match' } }] },
    });
    expect(await didit().validateBvn(input)).toEqual({
      outcome: 'match',
      requestId: 'dv_1',
      fieldMatches: { full_name: 'full_match', date_of_birth: 'full_match' },
    });
    expect(calls[0]).toMatchObject({
      path: '/v3/database-validation/',
      body: { issuing_state: 'NGA', bvn: '12345678901', first_name: 'Ada', last_name: 'Obi', date_of_birth: '2003-04-05', consent: true, services: ['nga_bvn'] },
    });
  });

  it('maps partial and no match', async () => {
    stubDidit(200, { request_id: 'dv_2', database_validation: { status: 'In Review', match_type: 'partial_match', validations: { full_name: 'partial_match' } } });
    expect((await didit().validateBvn(input)).outcome).toBe('partial');
    stubDidit(200, { request_id: 'dv_3', database_validation: { status: 'Declined', match_type: 'no_match', validations: [{ validation: { full_name: 'no_match' } }] } });
    expect((await didit().validateBvn(input)).outcome).toBe('no_match');
  });

  it('separates a refused BVN from an unavailable registry', async () => {
    stubDidit(400, { validation_errors: [{ code: 'provider_rejected_input', retryable: false }] });
    expect((await didit().validateBvn(input)).outcome).toBe('invalid');
    stubDidit(200, { request_id: 'dv_4', database_validation: { match_type: 'no_match', validations: [], errors: [{ code: 'empty_provider_response', retryable: true }] } });
    expect((await didit().validateBvn(input)).outcome).toBe('unavailable');
    stubDidit(502, { validation_errors: [{ code: 'empty_provider_response', retryable: true }] });
    await expect(didit().validateBvn(input)).rejects.toMatchObject({ retryable: true });
  });
});
