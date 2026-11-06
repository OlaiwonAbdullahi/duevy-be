import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiditVerifier } from './didit';

const input = { userId: 'usr_1', firstName: 'Ada', lastName: 'Obi', nin: '12345678901', dob: '2003-04-05' };

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
}

const validation = (outcome_code: string, score = '1.000') => ({
  request_id: 'req_123',
  status: 'Approved',
  validations: [{ service_id: 'nga_national_id', outcome_code, source_data: { name_match_score: score } }],
});

describe('DiditVerifier — reads the service outcome_code, not the HTTP status', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('MATCH, PARTIAL_MATCH and NO_MATCH', async () => {
    const v = new DiditVerifier('https://verification.didit.me', 'key');
    respond(200, validation('MATCH'));
    expect(await v.verifyNin(input)).toEqual({ outcome: 'match', requestId: 'req_123', nameMatchScore: 1 });
    respond(200, validation('PARTIAL_MATCH', '0.640'));
    expect(await v.verifyNin(input)).toMatchObject({ outcome: 'partial', nameMatchScore: 0.64 });
    respond(200, validation('NO_MATCH', '0'));
    expect((await v.verifyNin(input)).outcome).toBe('no_match');
  });

  it('a registry outage, a 5xx or a network error is unavailable — never the rep’s fault', async () => {
    const v = new DiditVerifier('https://verification.didit.me', 'key');
    respond(200, validation('REGISTRY_UNAVAILABLE'));
    expect((await v.verifyNin(input)).outcome).toBe('unavailable');
    respond(502, { validations: [{ service_id: 'nga_national_id', outcome_code: 'REGISTRY_ERROR' }] });
    expect((await v.verifyNin(input)).outcome).toBe('unavailable');
    respond(500, {});
    expect((await v.verifyNin(input)).outcome).toBe('unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect((await v.verifyNin(input)).outcome).toBe('unavailable');
  });

  it('a 400 (refused before reaching NIMC) is a no-match', async () => {
    respond(400, { detail: 'national_id must be exactly 11 characters long' });
    expect((await new DiditVerifier('https://verification.didit.me', 'key').verifyNin(input)).outcome).toBe('no_match');
  });

  it('sends the NIN and date of birth as multipart with the API key', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(validation('MATCH')), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new DiditVerifier('https://verification.didit.me', 'key_abc').verifyNin(input);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://verification.didit.me/v3/database-validation/');
    expect((init!.headers as Record<string, string>)['x-api-key']).toBe('key_abc');
    const form = init!.body as FormData;
    expect(form.get('services')).toBe('nga_national_id');
    expect(form.get('issuing_state')).toBe('NGA');
    expect(form.get('national_id')).toBe('12345678901');
    expect(form.get('date_of_birth')).toBe('2003-04-05');
    expect(form.get('vendor_data')).toBe('usr_1');
  });
});
