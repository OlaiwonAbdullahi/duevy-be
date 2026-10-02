import { type AddressInfo } from 'net';
import { type Server } from 'http';
import { randomUUID } from 'crypto';
import { db } from '../../config/db';
import { app } from '../../app';
import { signAccessToken } from '../../lib/jwt';
import { encrypt, maskAccountNumber } from '../../lib/encryption';
import { FakeProvider, setPaymentProvider } from '../../providers/payment';
import { computeBachsSignature } from '../../providers/payment/bachs/signature';
import { appendLedgerEntry } from '../../services/ledger.service';

export const WEBHOOK_SECRET = process.env.BACHS_WEBHOOK_SECRET ?? 'whsec_test_secret';

export function installFakeProvider(): FakeProvider {
  const fake = new FakeProvider([WEBHOOK_SECRET], 300);
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
      bachsAccountId: verified ? `acct_fake_${u}` : null,
      bachsPersonId: verified ? `per_fake_${u}` : null,
      bachsPayoutsActive: verified,
      studentIdStatus: verified ? 'approved' : null,
    },
  });
  const space = await db.space.create({
    data: { name: `Space ${u}`, short: 'TST', kind: 'department', school: 'LAUTECH', joinCode: `TST-${u}`.slice(0, 24) },
  });
  await db.spaceRep.create({ data: { userId: rep.id, spaceId: space.id, role: 'lead' } });
  await db.spaceMembership.create({ data: { userId: rep.id, spaceId: space.id } });
  if (verified) {
    await db.bankAccount.create({
      data: {
        spaceId: space.id,
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountNumber: encrypt('0123456789'),
        accountNumberMasked: maskAccountNumber('0123456789'),
        accountName: 'ADA OBI',
        bachsDestinationId: `pd_fake_${u}`,
        bachsAccountId: rep.bachsAccountId,
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
  return { rep, space, students, dues };
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

/** POST a signed Bachs-format event to the webhook route. */
export async function sendWebhook(event: { id: string; type: string; data: Record<string, unknown>; account?: string }) {
  const raw = JSON.stringify({ created_at: new Date().toISOString(), organization_id: 'acct_platform', ...event });
  const t = Math.floor(Date.now() / 1000);
  const sig = computeBachsSignature(WEBHOOK_SECRET, t, raw);
  const res = await fetch(`${base}/v1/webhooks/bachs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bachs-Signature-V2': `t=${t},v1=${sig}` },
    body: raw,
  });
  return res.status;
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
