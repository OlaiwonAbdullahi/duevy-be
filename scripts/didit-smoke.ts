/**
 * Didit smoke test: sends a real OTP to your phone, checks the code you type,
 * then (optionally) validates a NIN and a BVN. Database validation is billed
 * on live keys; sandbox keys return a static full_match.
 *
 *   npx tsx scripts/didit-smoke.ts <phone>                                        # OTP only
 *   npx tsx scripts/didit-smoke.ts <phone> <nin> <bvn> <first> <last> <YYYY-MM-DD>  # OTP + NIN + BVN
 *
 * Reads DIDIT_API_KEY (and optional DIDIT_BASE_URL) from .env.
 */
import 'dotenv/config';
import { createInterface } from 'readline/promises';

process.env.BANK78_CLIENT_ID ??= 'unused-by-smoke-test';
process.env.BANK78_CLIENT_SECRET ??= 'unused-by-smoke-test';
process.env.BANK78_API_KEY ??= 'unused-by-smoke-test';
process.env.BANK78_WEBHOOK_SECRET ??= 'unused-by-smoke-test';

async function main() {
  const [phoneInput, nin, bvn, firstName, lastName, dob] = process.argv.slice(2);
  if (!phoneInput) {
    console.error('usage: didit-smoke <phone> [nin bvn first last YYYY-MM-DD]');
    process.exit(1);
  }
  if (!process.env.DIDIT_API_KEY) {
    console.error('DIDIT_API_KEY is not set in .env');
    process.exit(1);
  }
  const { checkPhoneCode, normaliseNigerianPhone, sendPhoneCode, verifyIdNumber } = await import('../src/lib/didit');

  const phone = normaliseNigerianPhone(phoneInput);
  if (!phone) throw new Error(`${phoneInput} is not a Nigerian mobile number`);
  const userId = `smoke-${Date.now()}`;
  console.log(`send code to ${phone}:`, await sendPhoneCode(userId, phone));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('code from the SMS: ')).trim();
  rl.close();
  console.log('check code:', await checkPhoneCode(userId, phone, code));

  if (nin && bvn && firstName && lastName && dob) {
    console.log('NIN check:', await verifyIdNumber({ userId, kind: 'nin', number: nin, firstName, lastName, dob }));
    console.log('BVN check:', await verifyIdNumber({ userId, kind: 'bvn', number: bvn, firstName, lastName, dob }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
