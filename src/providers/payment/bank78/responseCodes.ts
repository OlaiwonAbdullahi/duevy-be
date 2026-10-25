import { type PayoutState } from '../types';

/**
 * Bank78's payout response codes (Payout and Sub-Accounts pages). A 200 is
 * not a successful transfer: the code decides. Bank78 adds codes over time and
 * says an unknown one must never be treated as failed, so anything not listed
 * here is `processing` and gets requeried.
 */

const SUCCESS = new Set(['00', 'NIP_SUCCESS']);

const FAILED = new Set([
  'NIP_FAILURE',
  '03', '05', '06', '07', '08', '12', '13', '14', '15', '16', '17', '18', '21', '25', '26', '30', '34',
  '51', '57', '58', '61', '63', '65', '69', '70', '71', '91', '92', '94', '98',
]);

export function payoutStateFromCode(code: string | null | undefined): PayoutState {
  if (!code) return 'processing';
  if (SUCCESS.has(code)) return 'succeeded';
  if (FAILED.has(code)) return 'failed';
  return 'processing';
}

/**
 * `result.status` on a payout query: Success, Pending, Processing, Failed or
 * Reversed. Pending/Processing stay open; Reversed means the money came back.
 */
export function payoutStateFromStatus(status: string | null | undefined): PayoutState | null {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
    case 'successful':
      return 'succeeded';
    case 'failed':
    case 'reversed':
      return 'failed';
    case 'pending':
    case 'processing':
      return 'processing';
    default:
      return null;
  }
}
