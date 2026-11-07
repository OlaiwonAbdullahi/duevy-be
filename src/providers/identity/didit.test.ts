import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiditVerifier, diditName } from './didit';

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

  it('every documented outcome code: verdicts, admin review, or "did not run"', async () => {
    const v = new DiditVerifier('https://verification.didit.me', 'key');
    const cases: [string, string][] = [
      ['DOCUMENT_NOT_FOUND', 'no_match'], ['DOCUMENT_SUPERSEDED', 'no_match'], ['INVALID_DOCUMENT_FORMAT', 'no_match'],
      ['DECEASED', 'no_match'], ['MINOR_BLOCKED', 'no_match'], ['INCONCLUSIVE', 'partial'], ['INVALID_INPUT', 'invalid_input'],
      ['REGISTRY_ERROR', 'unavailable'], ['SOMETHING_NEW', 'unavailable'],
    ];
    for (const [code, expected] of cases) {
      respond(200, validation(code));
      expect((await v.verifyNin(input)).outcome, code).toBe(expected);
    }
  });

  it('a 400 (our request refused before any lookup) is invalid_input, not the rep failing', async () => {
    respond(400, { detail: 'first_name has invalid characters' });
    expect((await new DiditVerifier('https://verification.didit.me', 'key').verifyNin(input)).outcome).toBe('invalid_input');
  });

  it('Didit refusing our account (key, credits, plan) is unavailable for the rep', async () => {
    const v = new DiditVerifier('https://verification.didit.me', 'key');
    // The exact answer the live key got on 2026-11-07.
    respond(403, { detail: "To protect against abuse, database validation is disabled until your organization's first top-up." });
    expect((await v.verifyNin(input)).outcome).toBe('unavailable');
    respond(401, { detail: 'Authentication credentials were not provided or are invalid.' });
    expect((await v.verifyNin(input)).outcome).toBe('unavailable');
    respond(402, {});
    expect((await v.verifyNin(input)).outcome).toBe('unavailable');
  });

  it('sends names Didit accepts: diacritics and other characters stripped', async () => {
    expect(diditName('Adébáyọ̀')).toBe('Adebayo');
    expect(diditName('Ọlámídé')).toBe('Olamide');
    expect(diditName('Ṣẹ̀gun')).toBe('Segun');
    expect(diditName("O'Neil-Okoro")).toBe("O'Neil-Okoro");
    expect(diditName('Chi 🙂 Chi2')).toBe('Chi Chi');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(validation('MATCH')), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new DiditVerifier('https://verification.didit.me', 'k').verifyNin({ ...input, firstName: 'Adébáyọ̀', lastName: 'Ọlámídé' });
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect([form.get('first_name'), form.get('last_name')]).toEqual(['Adebayo', 'Olamide']);
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
