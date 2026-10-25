import { describe, expect, it } from 'vitest';
import { payoutStateFromCode, payoutStateFromStatus } from './responseCodes';

describe('payoutStateFromCode', () => {
  it('succeeds only on 00 / NIP_SUCCESS', () => {
    expect(payoutStateFromCode('00')).toBe('succeeded');
    expect(payoutStateFromCode('NIP_SUCCESS')).toBe('succeeded');
  });

  it('fails on the documented failure codes', () => {
    for (const c of ['NIP_FAILURE', '07', '51', '94']) expect(payoutStateFromCode(c)).toBe('failed');
  });

  it('keeps pending and unknown codes open, never failed', () => {
    for (const c of ['01', '09', '110072', '9999', 'TRANSACTION_INITIATED', 'SOMETHING_NEW', null, undefined]) {
      expect(payoutStateFromCode(c)).toBe('processing');
    }
  });
});

describe('payoutStateFromStatus', () => {
  it('maps a query status', () => {
    expect(payoutStateFromStatus('Success')).toBe('succeeded');
    expect(payoutStateFromStatus('Reversed')).toBe('failed');
    expect(payoutStateFromStatus('Failed')).toBe('failed');
    expect(payoutStateFromStatus('Processing')).toBe('processing');
    expect(payoutStateFromStatus('Pending')).toBe('processing');
    expect(payoutStateFromStatus('Weird')).toBeNull();
  });
});
