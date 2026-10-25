import { type AddressInfo } from 'net';
import { type Server } from 'http';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../../config/db';
import { app } from '../../app';
import { signAccessToken } from '../../lib/jwt';
import { encrypt, maskAccountNumber } from '../../lib/encryption';
import { FakeProvider, setPaymentProvider } from '../../providers/payment';
import { computeKrediSignature } from '../../providers/payment/kredi/signature';
import { koboToDecimal } from '../../lib/money';
import { appendLedgerEntry } from '../../services/ledger.service';

/** Withdrawal security code every fixture space is given (see makeSpace). */
export const TEST_PIN = '2580';
const TEST_PIN_HASH = bcrypt.hashSync(TEST_PIN, 4);

export const WEBHOOK_SECRET = process.env.KREDI_WEBHOOK_SECRET ?? 'whsec_test_secret';

export function installFakeProvider(): FakeProvider {
  const fake = new FakeProvider([WEBHOOK_SECRET]);
  setPaymentProvider(fake);
  return fake;
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A KYC-verified lead rep with a space, a payout account, and N members. */
export async function makeSpace(opts: { members?: number; dues?: number[]; verified?: boolean } = {}) {
  const u = uniq();
  const verified = opts.verified ?? true;
  const rep = await db.user.create({
    data: {
      name: 'Ada Obi',
      email: `rep_${u}@test.duevy`,
      role: 'rep',
      isRep: true,
      repApplicationStatus: 'approved',
      kycStatus: verified ? 'verified' : 'unverified',
      providerAccountId: verified ? `cus_fake_${u}` : null,
      providerAccountNumber: verified ? '9900000000' : null,
      payoutsActive: verified,
      phoneVerifiedAt: verified ? new Date() : null,
      bvnVerifiedAt: verified ? new Date() : null,
      studentIdStatus: verified ? 'approved' : null,
    },
  });
  const space = await db.space.create({
    data: {
      name: `Space ${u}`, short: 'TST', kind: 'department', school: 'LAUTECH', joinCode: `TST-${u}`.slice(0, 24),
      withdrawalPinHash: TEST_PIN_HASH, withdrawalPinSetAt: new Date(),
    },
  });
  await db.spaceRep.create({ data: { userId: rep.id, spaceId: space.id, role: 'lead' } });
  await db.spaceMembership.create({ data: { userId: rep.id, spaceId: space.id } });
  let beneficiary = null;
  if (verified) {
    beneficiary = await db.payoutBeneficiary.create({
      data: {
        spaceId: space.id,
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountNumber: encrypt('0123456789'),
        accountNumberMasked: maskAccountNumber('0123456789'),
        accountName: 'ADA OBI',
      },
    });
  }

  const students = [];
  for (let i = 0; i < (opts.members ?? 1); i++) {
    const s = await db.user.create({ data: { name: `Student ${i}`, email: `stu_${u}_${i}@test.duevy` } });
    await db.spaceMembership.create({ data: { userId: s.id, spaceId: space.id } });
    students.push(s);
  }

  const dues = [];
  for (const amount of opts.dues ?? [500_000]) {
    dues.push(
      await db.due.create({
        data: { spaceId: space.id, title: `Due ${amount}`, amount, dueDate: new Date(Date.now() + 7 * 864e5), category: 'departmental_due', status: 'active' },
      }),
    );
  }
  return { rep, space, students, dues, beneficiary };
}

/** Put money on a space's ledger directly (as if collected). */
export async function creditSpace(spaceId: string, amountKobo: number, note = 'test credit') {
  await db.$transaction((tx) =>
    appendLedgerEntry(tx, {
      spaceId,
      type: 'manual_credit',
      direction: 'credit',
      amountKobo,
      reference: `TEST-${uniq()}`,
      description: note,
    }),
  );
}

export async function tokenFor(user: { id: string; role: string }) {
  return signAccessToken({ sub: user.id, role: user.role, spaceIds: [] });
}

// --- HTTP ------------------------------------------------------------------

let server: Server | null = null;
let base = '';

export async function startHttp(): Promise<string> {
  if (server) return base;
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return base;
}

export async function stopHttp(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

export async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** POST a body to the Kredi webhook route, signed over amount-secret-reference. */
export async function sendKrediWebhook(body: Record<string, unknown>, signed: { amount: string; reference: string }) {
  const res = await fetch(`${base}/v1/webhooks/kredi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'signature-key': computeKrediSignature(signed.amount, WEBHOOK_SECRET, signed.reference) },
    body: JSON.stringify(body),
  });
  return res.status;
}

/** A Kredi collection webhook: `amountKobo` arrived on the checkout's payment link. */
export async function sendCollectionWebhook(reference: string, amountKobo: number, opts: { remitReference?: string; status?: string } = {}) {
  const remitReference = opts.remitReference ?? `remit_${reference}_${amountKobo}`;
  const amount = koboToDecimal(amountKobo);
  return sendKrediWebhook(
    {
      merchantRef: reference,
      amount,
      amountReceived: amount,
      status: opts.status ?? 'successful',
      remitReference,
      sessionId: `sess_${remitReference}`,
      accountType: 'collection',
      createdAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    },
    { amount, reference: remitReference },
  );
}

/** A Kredi payout (outward) webhook: 200 succeeded, 401 failed. */
export async function sendPayoutWebhook(reference: string, code: 200 | 401 | 100, amountKobo: number, krediReference = `KRDM_${reference}`) {
  const amount = Number(koboToDecimal(amountKobo));
  return sendKrediWebhook(
    {
      krediReference,
      merchantReference: reference,
      transactionAmount: amount,
      transactionStatus: { code, status_message: code === 200 ? 'Successful' : code === 401 ? 'Failed' : 'Processing' },
      transactionStatusMessage: code === 401 ? 'Beneficiary bank declined' : 'Approved',
      createdAt: new Date().toISOString(),
    },
    { amount: String(amount), reference },
  );
}

export const newKey = () => randomUUID();

/** A minimal valid PNG (8-byte signature + padding), for document uploads. */
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** multipart/form-data request: string fields plus named files. */
export async function apiMultipart(
  path: string,
  opts: { token: string; fields?: Record<string, string>; files?: Record<string, { bytes: Buffer; name: string; type: string }> },
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  for (const [k, f] of Object.entries(opts.files ?? {})) form.append(k, new Blob([f.bytes], { type: f.type }), f.name);
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${opts.token}` }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
