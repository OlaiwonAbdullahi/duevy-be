/**
 * Bank78 SANDBOX smoke test: exercises every Bank78 call Duevy makes, in the
 * order the money moves, and prints PASS / FAIL per step.
 *
 *   npx tsx scripts/bank78-smoke.ts
 *
 * Reads BANK78_CLIENT_ID, BANK78_CLIENT_SECRET and BANK78_API_KEY from .env.
 * Always runs against https://sandbox.bank78.co, whatever BANK78_BASE_URL says:
 * it moves money, so it never touches live.
 *
 *  1. token (via the first call) and the merchant balance
 *  2. bank list and a name enquiry
 *  3. a rep wallet (sub-account)
 *  4. a dynamic virtual account for a ₦100 checkout, read back by reference
 *  5. sandbox funding of that account (Bank78's test credit)
 *  6. routing ₦100 from the merchant account into the wallet, and its balance
 *  7. a ₦50 payout from the wallet to Bank78's test account, then a status query
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';

const SANDBOX = 'https://sandbox.bank78.co';
// The provider loads src/config/env.ts; these keep it from refusing to start
// for settings this script doesn't use.
process.env.BANK78_BASE_URL = SANDBOX;
process.env.DIDIT_API_KEY ??= 'unused-by-smoke-test';
process.env.BANK78_WEBHOOK_SECRET ??= 'unused-by-smoke-test';

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];

async function step<T>(name: string, fn: () => Promise<T>, show: (v: T) => string = (v) => JSON.stringify(v)): Promise<T | null> {
  try {
    const v = await fn();
    steps.push({ name, ok: true, detail: show(v) });
    console.log(`PASS  ${name}  ${show(v)}`);
    return v;
  } catch (err) {
    const e = err as Error & { status?: number; code?: string };
    const detail = `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}${e.code ? ` [${e.code}]` : ''}`;
    steps.push({ name, ok: false, detail });
    console.log(`FAIL  ${name}  ${detail}`);
    return null;
  }
}

async function main() {
  for (const k of ['BANK78_CLIENT_ID', 'BANK78_CLIENT_SECRET', 'BANK78_API_KEY'] as const) {
    if (!process.env[k] || process.env[k]!.length < 8) {
      console.error(`${k} is missing or a placeholder. Put the sandbox credentials from the Bank78 dashboard (API Credentials) in .env.`);
      process.exit(1);
    }
  }
  const { Bank78Provider } = await import('../src/providers/payment/bank78/Bank78Provider');
  const { Bank78Client } = await import('../src/providers/payment/bank78/client');
  const creds = {
    baseUrl: SANDBOX,
    clientId: process.env.BANK78_CLIENT_ID!,
    clientSecret: process.env.BANK78_CLIENT_SECRET!,
    apiKey: process.env.BANK78_API_KEY!,
  };
  const provider = new Bank78Provider({ ...creds, webhookSecrets: ['unused'], webhookToleranceSeconds: 300 });
  const raw = new Bank78Client(creds);
  const run = randomUUID().slice(0, 8);

  await step('merchant balance', () => raw.request<{ availableBalance: number }>({ method: 'GET', path: '/payout/balance', op: 'smoke.balance' }), (r) => `₦${r.availableBalance}`);
  const banks = await step('bank list', () => provider.listBanks(), (b) => `${b.length} banks, e.g. ${b.slice(0, 3).map((x) => `${x.code} ${x.name}`).join(', ')}`);
  if (banks?.length === 0) console.log('      the bank list came back empty — check the response shape in Bank78Provider.listBanks');
  // Sandbox test BVN: Bank78 refuses a sub-account without one.
  const profile = { userId: `smoke-${run}`, firstName: 'Smoke', lastName: 'Test', email: `smoke-${run}@duevy.test`, phone: '08012345678', bvn: '22222222221' };
  const wallet = await step('create rep wallet (sub-account)', () => provider.createWallet(profile));
  if (wallet) {
    await step('create the same wallet again (idempotent)', () => provider.createWallet(profile), (w) => `same account: ${w.accountNumber === wallet.accountNumber}`);
    await step('name enquiry on the wallet', () => provider.resolveAccount('110072', wallet.accountNumber));
  }

  const reference = `DVY-SMK-${run.toUpperCase().slice(0, 4)}`;
  const account = await step(`open dynamic virtual account ${reference} for ₦100`, () =>
    provider.createCollectionAccount({ reference, faceKobo: 9_852, platformFeeKobo: 148, customer: { email: 'student@duevy.test', name: 'Smoke Student' }, expiresInMinutes: 30, metadata: {} }),
  );
  if (account) {
    await step('re-open the same reference (idempotent retry)', () =>
      provider.createCollectionAccount({ reference, faceKobo: 9_852, platformFeeKobo: 148, customer: { email: 'student@duevy.test', name: 'Smoke Student' }, expiresInMinutes: 30, metadata: {} }),
      (a) => `same account: ${a.accountNumber === account.accountNumber}`,
    );
    const lookup = () =>
      raw.request<{ isActive?: boolean; accountNumber: string }>({ method: 'GET', path: `/virtual-nuban/api/virtual-nubans/accountRef/${reference}`, op: 'smoke.va' });
    await step('read the account back by reference', lookup, (r) => `isActive=${r.isActive}`);
    await step('sandbox funding ₦100 into it', () =>
      raw.request({
        method: 'POST',
        path: '/virtual-nuban/api/transaction-notification-fund',
        op: 'smoke.fund',
        body: {
          beneficiaryAccountName: account.accountName,
          beneficiaryAccountNumber: account.accountNumber,
          originatorAccountName: 'Smoke Payer',
          originatorAccountNumber: '0220901228',
          narration: 'Duevy smoke test',
          paymentReference: randomUUID(),
          amount: '100',
        },
      }),
    );
    // Settles what getCollectionStatus may infer: does a paid dynamic account go inactive?
    await step('account state after the credit', lookup, (r) => `isActive=${r.isActive}`);
  }

  if (wallet) {
    await step('route ₦100 from the merchant account into the wallet', () => provider.routeCollection({ accountId: wallet.accountNumber, amountKobo: 10_000, reference: `RT-${reference}` }));
    await step('wallet balance', () => provider.getWallet(wallet.accountNumber), (w) => `₦${(w.availableKobo ?? 0) / 100}, active=${w.active}`);
    const dest = await provider.registerPayoutDestination({ accountId: wallet.accountNumber, bankCode: '110072', bankName: 'Bank78', accountNumber: '1010002241', accountName: 'Megan Idowu' });
    const payoutRef = `WD-SMK-${run}`;
    const payout = await step('pay ₦50 out of the wallet', () => provider.initiatePayout({ accountId: wallet.accountNumber, destinationId: dest.destinationId, amountKobo: 5_000, reference: payoutRef }), (p) => `${p.state}, Bank78 fee ₦${(p.providerFeeKobo ?? 0) / 100}`);
    if (payout) await step('query the payout', () => provider.getPayout(wallet.accountNumber, payoutRef), (p) => `${p.state}, fee ₦${(p.providerFeeKobo ?? 0) / 100}`);
  }

  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
