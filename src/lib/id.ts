import { ulid } from 'ulid';

/** Prefixed ULID generator matching the API spec's identifier scheme.
 *
 *  Examples: usr_01JZXYZ…  spc_01JZXYZ…  due_01JZXYZ…
 */
const prefixes = {
  user: 'usr',
  space: 'spc',
  due: 'due',
  transaction: 'txn',
  poll: 'pol',
  payout: 'pyt',
  notification: 'ntf',
  dispute: 'dsp',
  report: 'rpt',
} as const;

type Prefix = keyof typeof prefixes;

export function generateId(prefix: Prefix): string {
  return `${prefixes[prefix]}_${ulid()}`;
}
