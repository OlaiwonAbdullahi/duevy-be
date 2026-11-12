import { Resend } from 'resend';
import { env } from '../config/env';
import { escapeHtml } from './html';

const resend = new Resend(env.RESEND_API_KEY);

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: { filename: string; content: Buffer }[];
}

/** Strip CR/LF so a user-controlled value can never inject extra headers via the subject. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: Array.isArray(options.to) ? options.to : [options.to],
    subject: headerSafe(options.subject),
    html: options.html,
    text: options.text,
    attachments: options.attachments,
  });

  if (error) {
    console.error('[email] Failed to send email:', error);
    throw new Error(`Email send failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

const SITE = 'https://www.duevy.app';
const BRAND = '#0b6e4f';
const INK = '#1f2421';
const INK_SOFT = '#6b716e';
const LINE = '#e8e8e6';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Callers write plain `<h1>`, `<p>`, `<p class="muted">`, `class="btn"` and
 * `class="callout"`. Some clients (Gmail with non-Google accounts, Outlook)
 * drop `<style>` blocks, so the styles are stamped inline.
 */
function inlineStyles(content: string): string {
  return content
    .replace(/<h1>/g, `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:20px;line-height:1.35;font-weight:600;color:${INK};">`)
    .replace(/<p class="muted">/g, `<p class="muted" style="margin:0 0 14px;font-family:${FONT};font-size:13px;line-height:1.6;color:${INK_SOFT};">`)
    .replace(/<p>/g, `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">`)
    .replace(/class="btn"/g, `class="btn" style="display:inline-block;background:${BRAND};color:#ffffff;border-radius:6px;padding:10px 18px;font-family:${FONT};font-size:14px;font-weight:600;text-decoration:none;margin:4px 0 24px;"`)
    .replace(/class="callout"/g, `class="callout" style="border-left:3px solid ${LINE};padding:2px 0 2px 12px;margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};"`);
}

/** The one figure the email is about (an amount, a code), large and centred. */
export function emailHero(value: string): string {
  return `
    <div style="margin:8px 0 24px;font-family:${FONT};text-align:center;font-size:28px;line-height:1.3;font-weight:600;color:${INK};">${value}</div>`;
}

/** Label/value rows separated by thin lines. */
export function emailDetails(rows: [string, string][]): string {
  const body = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:9px 12px 9px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${INK_SOFT};vertical-align:top;">${label}</td>
        <td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${INK};word-break:break-word;">${value}</td>
      </tr>`,
    )
    .join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-bottom:1px solid ${LINE};">${body}</table>`;
}

/**
 * The shared email shell: the Duevy logo (public/logos/duevy-logo-green.png
 * on the web app; "Duevy" in text where images are off), the content, and a
 * one-line footer on a plain white page. `tone` is kept for existing callers
 * and doesn't change the look. `preheader` is the inbox preview line, plain
 * text (escaped here).
 */
export function renderEmail(content: string, _tone = BRAND, opts: { preheader?: string } = {}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Duevy</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:32px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td style="padding:0 0 28px;">
              <a href="${SITE}" style="text-decoration:none;"><img src="${SITE}/logos/duevy-logo-green.png" width="104" height="30" alt="Duevy" style="display:block;width:104px;height:30px;border:0;font-family:${FONT};font-size:17px;font-weight:700;color:${BRAND};" /></a>
            </td>
          </tr>
          <tr>
            <td style="font-family:${FONT};color:${INK};">
              ${inlineStyles(content)}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 0 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:12px;line-height:1.6;color:${INK_SOFT};">
              Duevy · <a href="${SITE}" style="color:${INK_SOFT};">duevy.app</a> · <a href="mailto:support@duevy.app" style="color:${INK_SOFT};">support@duevy.app</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

/** "Ada" from "Ada Obi": every greeting uses the first name. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "12 Nov 2026, 4:39 pm", in Lagos time. */
function lagosTime(at: Date): string {
  return at.toLocaleString('en-NG', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Lagos',
  });
}

export async function sendVerificationEmail(
  to: string,
  name: string,
  token: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/verify-email?token=${token}`;
  const html = renderEmail(`
    <h1>Verify your email</h1>
    <p>Hi ${escapeHtml(firstName(name))}, confirm this address to finish setting up your Duevy account.</p>
    <a href="${link}" class="btn">Verify email</a>
    <p class="muted">The link expires in 24 hours. If you didn't sign up for Duevy, ignore this email.</p>
  `);

  await sendEmail({
    to,
    subject: 'Verify your email for Duevy',
    html,
    text: `Hi ${firstName(name)},\n\nConfirm this address to finish setting up your Duevy account:\n${link}\n\nThe link expires in 24 hours. If you didn't sign up for Duevy, ignore this email.`,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  token: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/reset-password?token=${token}`;
  const html = renderEmail(
    `
    <h1>Reset your password</h1>
    <p>Hi ${escapeHtml(firstName(name))}, someone asked to reset the password on your Duevy account. If that was you, choose a new one here:</p>
    <a href="${link}" class="btn">Choose a new password</a>
    <p class="muted">The link expires in 1 hour. If you didn't ask for this, ignore this email and your password stays the same.</p>
  `,
  );

  await sendEmail({
    to,
    subject: 'Reset your Duevy password',
    html,
    text: `Hi ${firstName(name)},\n\nSomeone asked to reset the password on your Duevy account. If that was you, choose a new one here:\n${link}\n\nThe link expires in 1 hour. If you didn't ask for this, ignore this email and your password stays the same.`,
  });
}

/**
 * "See my receipts": a link to every receipt issued to this email, from the
 * public lookup page. The link is the only proof the person owns the inbox.
 */
export async function sendReceiptLookupEmail(to: string, link: string, count: number): Promise<void> {
  const what = count === 1 ? 'your receipt' : `your ${count} receipts`;
  const html = renderEmail(
    `
    <h1>Your receipts</h1>
    <p>Someone (hopefully you) asked to see the payments made with this email address. This link opens ${what}, ready to download.</p>
    <a href="${link}" class="btn">View receipts</a>
    <p class="muted">It expires in 1 hour and only works for this address. If you didn't ask for it, ignore this email.</p>
  `,
    undefined,
    { preheader: `The link to ${what} on Duevy.` },
  );
  await sendEmail({
    to,
    subject: 'Your Duevy receipts',
    html,
    text: `Someone (hopefully you) asked to see the payments made with this email address. This link opens ${what}:\n${link}\n\nIt expires in 1 hour. If you didn't ask for it, ignore this email.`,
  });
}

/**
 * A guest who ticked "create a free Duevy account" at checkout, sent once their
 * payment is confirmed. The link is a single-use set-password token; no
 * password is ever generated or emailed.
 */
export async function sendAccountActivationEmail(
  to: string,
  name: string,
  token: string,
  opts: { spaceName: string; expiresInHours: number },
): Promise<void> {
  const link = `${env.FRONTEND_URL}/reset-password?token=${token}&activate=1`;
  const html = renderEmail(
    `
    <h1>Set a password for your account</h1>
    <p>Hi ${escapeHtml(firstName(name))}, you asked for a Duevy account when you paid ${escapeHtml(opts.spaceName)}, so we made one for this email address. Once you set a password you can sign in to see your receipts and pay future dues.</p>
    <a href="${link}" class="btn">Set password</a>
    <p class="muted">The link works once and expires in ${opts.expiresInHours} hours. If you didn't ask for an account, ignore this email.</p>
  `,
    BRAND,
    { preheader: 'Set a password to sign in and see your receipts.' },
  );

  await sendEmail({
    to,
    subject: 'Set a password for your Duevy account',
    html,
    text: `Hi ${firstName(name)},\n\nYou asked for a Duevy account when you paid ${opts.spaceName}, so we made one for this email address. Set a password to sign in:\n${link}\n\nThe link works once and expires in ${opts.expiresInHours} hours.`,
  });
}

export type DuePaymentReceipt = {
  spaceName: string;
  reference: string;
  /** Null only if the receipt row couldn't be read; the email still goes out. */
  receiptNumber: string | null;
  /** Every due settled by this payment, at its face amount. */
  items: { title: string; amountKobo: number }[];
  faceKobo: number;
  feeKobo: number;
  /** What the student actually sent. */
  amountPaidKobo: number;
  paidAt: Date;
  /**
   * Where "View receipt" goes. Defaults to the app's payment page, which is
   * behind sign-in — so guests get their token-unlocked pay-link page instead.
   */
  receiptUrl?: string;
};

const nairaExact = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The breakdown under the total: each due, the dues total (for several) and the fee. */
function emailReceiptTable(input: DuePaymentReceipt): string {
  const row = (label: string, value: string, opts: { soft?: boolean } = {}) => `
      <tr>
        <td style="padding:9px 12px 9px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${opts.soft ? INK_SOFT : INK};">${label}</td>
        <td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${INK};white-space:nowrap;vertical-align:top;">${value}</td>
      </tr>`;
  const items = input.items.map((item) => row(escapeHtml(item.title), nairaExact(item.amountKobo))).join('');
  const subtotal = input.items.length > 1 ? row('Dues total', nairaExact(input.faceKobo), { soft: true }) : '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-bottom:1px solid ${LINE};">
      ${items}
      ${subtotal}
      ${row('Processing fee', nairaExact(input.feeKobo), { soft: true })}
    </table>`;
}

/** Subject, HTML and text for a dues payment receipt: one due or a basket of many. */
export function buildDuePaymentReceiptEmail(name: string, input: DuePaymentReceipt) {
  const amount = nairaExact(input.amountPaidKobo);
  // The app's payment page shows the full receipt and its PDF download (behind sign-in).
  const receiptLink = input.receiptUrl ?? `${env.FRONTEND_URL}/dashboard/pay/${encodeURIComponent(input.reference)}`;
  const paidAt = lagosTime(input.paidAt);
  const single = input.items.length === 1;
  const summary = single ? input.items[0]!.title : `${input.items.length} dues`;
  const to = input.spaceName ? ` to ${input.spaceName}` : '';
  const lead = single
    ? `Hi ${firstName(name)}, thanks for paying ${summary}${to}.`
    : `Hi ${firstName(name)}, thanks for paying ${input.items.length} dues${to}. All of them are now marked as paid.`;
  const details: [string, string][] = [
    ...(input.receiptNumber ? ([['Receipt no.', input.receiptNumber]] as [string, string][]) : []),
    ['Date', paidAt],
    ['Method', 'Bank transfer'],
    ['Reference', input.reference],
  ];
  const note = `${input.spaceName || 'Your department'} gets the full ${nairaExact(input.faceKobo)}. The 1.5% processing fee is charged on top. You can use this email as proof of payment.`;

  const html = renderEmail(
    `
    <h1>Your receipt</h1>
    <p>${escapeHtml(lead)}</p>
    ${emailHero(amount)}
    ${emailReceiptTable(input)}
    ${emailDetails(details.map(([k, v]) => [k, escapeHtml(v)] as [string, string]))}
    <a href="${receiptLink}" class="btn">View receipt</a>
    <p class="muted">${escapeHtml(note)}</p>
  `,
    undefined,
    { preheader: `Your receipt for ${summary}.` },
  );

  const lines = input.items.map((i) => `${i.title}: ${nairaExact(i.amountKobo)}`).join('\n');
  const text =
    `${lead}\n\n${lines}\n` +
    `${single ? '' : `Dues total: ${nairaExact(input.faceKobo)}\n`}Processing fee: ${nairaExact(input.feeKobo)}\nTotal paid: ${amount}\n\n` +
    details.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\n${note}\n\nView receipt: ${receiptLink}`;

  return { subject: `Your receipt for ${summary}`, html, text };
}

/** `pdf`, when given, is attached — the same receipt PDF the app downloads. */
export async function sendDuePaymentReceiptEmail(
  to: string,
  name: string,
  input: DuePaymentReceipt,
  pdf?: { filename: string; pdf: Buffer },
): Promise<void> {
  await sendEmail({
    to,
    ...buildDuePaymentReceiptEmail(name, input),
    ...(pdf ? { attachments: [{ filename: pdf.filename, content: pdf.pdf }] } : {}),
  });
}

export type RepPaymentReceived = {
  spaceName: string;
  payerName: string;
  reference: string;
  /** Every due settled by this payment, at its face amount. */
  items: { title: string; amountKobo: number }[];
  /** What the space receives: the dues' face amount, without the student's processing fee. */
  faceKobo: number;
  paidAt: Date;
  /** The due's collections roster, or the dues list for a basket. */
  link: string;
};

/** Subject, HTML and text telling a rep a member paid into their space. */
export function buildRepPaymentReceivedEmail(repName: string, input: RepPaymentReceived) {
  const amount = nairaExact(input.faceKobo);
  const single = input.items.length === 1;
  const summary = single ? input.items[0]!.title : `${input.items.length} dues`;
  const payer = input.payerName;
  const lead = `Hi ${firstName(repName)}, ${payer} just paid ${amount} for ${summary} in ${input.spaceName}. It's already in the space balance.`;
  const rows: [string, string][] = [
    ...(single ? [] : input.items.map((i) => [i.title, nairaExact(i.amountKobo)] as [string, string])),
    ['Date', lagosTime(input.paidAt)],
    ['Reference', input.reference],
  ];
  const optOut = 'To stop these emails, go to Settings, then Notifications, and turn off Payment emails.';
  const html = renderEmail(
    `
    <h1>${escapeHtml(payer)} paid</h1>
    ${emailHero(amount)}
    <p>${escapeHtml(`Hi ${firstName(repName)}, that's for ${summary} in ${input.spaceName}, and it's already in the space balance.`)}</p>
    ${emailDetails(rows.map(([k, v]) => [escapeHtml(k), escapeHtml(v)] as [string, string]))}
    <a href="${input.link}" class="btn">View collections</a>
    <p class="muted">The student pays the processing fee on top, so the space gets the full amount. ${optOut}</p>
  `,
    undefined,
    { preheader: `${payer} paid ${amount} for ${summary}.` },
  );
  const text =
    `${lead}\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nView collections: ${input.link}\n\n${optOut}`;
  return { subject: `${payer} paid ${amount} for ${summary}`, html, text };
}

export async function sendRepPaymentReceivedEmail(to: string, repName: string, input: RepPaymentReceived): Promise<void> {
  await sendEmail({ to, ...buildRepPaymentReceivedEmail(repName, input) });
}

export async function sendRepApplicationReceivedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const html = renderEmail(`
    <h1>We got your application</h1>
    <p>Hi ${escapeHtml(firstName(name))}, thanks for applying to be a rep for ${escapeHtml(spaceName)}. We'll review it within one or two business days and email you with our decision.</p>
  `);

  await sendEmail({
    to,
    subject: 'We got your Duevy rep application',
    html,
    text: `Hi ${firstName(name)},\n\nThanks for applying to be a rep for ${spaceName}. We'll review it within one or two business days and email you with our decision.`,
  });
}

/** Nudges for a rep applicant who hasn't finished verification (stage 1–3). */
/**
 * What to have ready, from the KYC policy at send time: "your student ID card
 * and a camera for a quick photo or video of your face", and the NIN/date of
 * birth only while they're required.
 */
function kycNeeds(req: { nin: boolean; liveness: boolean }): string {
  const items = [
    req.nin ? 'your NIN' : null,
    req.nin ? 'your date of birth' : null,
    'your student ID card',
    req.liveness ? 'your phone camera for a quick photo or video of your face' : null,
  ].filter(Boolean) as string[];
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]!;
}

export async function sendKycReminderEmail(
  to: string,
  name: string,
  stage: 1 | 2 | 3,
  requirements: { nin: boolean; liveness: boolean } = { nin: false, liveness: true },
): Promise<void> {
  const link = `${env.FRONTEND_URL}/onboarding`;
  const first = firstName(name);
  const copy = {
    1: {
      subject: 'One step left on your Duevy rep account',
      heading: 'One step left',
      body: `Hi ${first}, you signed up as a rep on Duevy but haven't verified your identity yet. It takes about two minutes, and your department can collect dues as soon as it's done.`,
    },
    2: {
      subject: "Your department can't collect dues on Duevy yet",
      heading: "Your verification isn't finished",
      body: `Hi ${first}, your department can't collect dues until you verify your rep account. You'll need ${kycNeeds(requirements)}.`,
    },
    3: {
      subject: 'Last reminder to verify your Duevy rep account',
      heading: 'Last reminder',
      body: `Hi ${first}, you signed up as a rep a week ago and still haven't finished verifying. If something is stopping you, reply to this email and we'll help.`,
    },
  }[stage];

  const html = renderEmail(
    `
    <h1>${copy.heading}</h1>
    <p>${escapeHtml(copy.body)}</p>
    <a href="${link}" class="btn">Finish verification</a>
    <p class="muted">Already done? Ignore this email.</p>
  `,
    BRAND,
    { preheader: requirements.nin ? 'Verify your NIN and student ID in a few minutes.' : 'Verify your student ID in a few minutes.' },
  );

  await sendEmail({ to, subject: copy.subject, html, text: `${copy.body}\n\nFinish verification: ${link}` });
}

export async function sendRepApprovedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/dashboard`;
  const html = renderEmail(`
    <h1>You're approved</h1>
    <p>Hi ${escapeHtml(firstName(name))}, you're now the rep for ${escapeHtml(spaceName)} on Duevy. You can set up dues from your dashboard.</p>
    <a href="${link}" class="btn">Open dashboard</a>
  `);

  await sendEmail({
    to,
    subject: `You're the rep for ${spaceName} on Duevy`,
    html,
    text: `Hi ${firstName(name)},\n\nYou're now the rep for ${spaceName} on Duevy. You can set up dues from your dashboard: ${link}`,
  });
}

/** The applicant's department already had a space, so they joined it as a co-rep. */
export async function sendCoRepApprovedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/dashboard`;
  const html = renderEmail(`
    <h1>You're approved</h1>
    <p>Hi ${escapeHtml(firstName(name))}, ${escapeHtml(spaceName)} was already on Duevy, so we've added you to it as a co-rep. You'll run its dues with the lead rep.</p>
    <a href="${link}" class="btn">Open dashboard</a>
  `);

  await sendEmail({
    to,
    subject: `You're now a co-rep of ${spaceName} on Duevy`,
    html,
    text: `Hi ${firstName(name)},\n\n${spaceName} was already on Duevy, so we've added you to it as a co-rep. You'll run its dues with the lead rep: ${link}`,
  });
}

export async function sendRepRejectedEmail(
  to: string,
  name: string,
  reason: string,
): Promise<void> {
  const html = renderEmail(
    `
    <h1>About your rep application</h1>
    <p>Hi ${escapeHtml(firstName(name))}, we couldn't approve your application to be a rep. The reviewer's note:</p>
    <div class="callout">${escapeHtml(reason)}</div>
    <p>You can still use Duevy as a student. If you think we got this wrong, email support@duevy.app.</p>
  `,
  );

  await sendEmail({
    to,
    subject: 'About your Duevy rep application',
    html,
    text: `Hi ${firstName(name)},\n\nWe couldn't approve your application to be a rep. The reviewer's note:\n\n${reason}\n\nYou can still use Duevy as a student. If you think we got this wrong, email support@duevy.app.`,
  });
}

export type WithdrawalUpdate = {
  outcome: 'success' | 'failed' | 'reversed' | 'cancelled';
  spaceName: string;
  /** What reached (or would have reached) the recipient. */
  netKobo: number;
  /** Duevy's withdrawal fee. */
  feeKobo: number;
  /** What came off the space balance: net + fee. Restored in full unless it succeeded. */
  grossKobo: number;
  /** "ADA OBI · GTBank •••• 4021". */
  destination: string;
  dueTitle: string | null;
  requestedBy: string;
  /** Whether this rep made the withdrawal: "You sent…" vs "Ada sent…". */
  viewerIsRequester: boolean;
  reference: string;
  /** Why it failed or was cancelled. */
  reason: string | null;
  at: Date;
  link: string;
};

/**
 * Subject, HTML and text telling a rep how a withdrawal from their space
 * ended. Every rep gets it, whatever their notification settings: money
 * leaving the space is something each of them should be able to spot.
 */
export function buildWithdrawalUpdateEmail(name: string, w: WithdrawalUpdate) {
  const net = nairaExact(w.netKobo);
  const gross = nairaExact(w.grossKobo);
  const first = firstName(name);
  const who = w.viewerIsRequester ? 'You' : w.requestedBy;
  const restored = `The full ${gross} is back in the space balance.`;
  const copy = {
    success: {
      heading: 'Withdrawal sent',
      lead: `${who} sent ${net} from ${w.spaceName} to ${w.destination}.`,
      subject: `${who} sent ${net} from ${w.spaceName}`,
    },
    failed: {
      heading: 'Withdrawal failed',
      lead: `The ${net} withdrawal from ${w.spaceName} to ${w.destination} didn't go through. ${restored} You can try again from the Payout page.`,
      subject: `Your ${net} withdrawal from ${w.spaceName} failed`,
    },
    reversed: {
      heading: 'Withdrawal reversed',
      lead: `The bank returned the ${net} withdrawal from ${w.spaceName} to ${w.destination}. ${restored}`,
      subject: `The bank returned a ${net} withdrawal from ${w.spaceName}`,
    },
    cancelled: {
      heading: 'Withdrawal cancelled',
      lead: `The ${net} withdrawal from ${w.spaceName} to ${w.destination} was cancelled before it was sent. ${restored}`,
      subject: `A ${net} withdrawal from ${w.spaceName} was cancelled`,
    },
  }[w.outcome];

  // Only what the sentence above doesn't already say. Plain values; escaped for the HTML.
  const rows: [string, string][] = [
    ...(w.outcome === 'success'
      ? ([['Fee', nairaExact(w.feeKobo)], ['Taken from balance', gross]] as [string, string][])
      : ([['Requested by', w.viewerIsRequester ? `You (${w.requestedBy})` : w.requestedBy]] as [string, string][])),
    ...(w.reason && w.outcome !== 'success' ? [['Reason', w.reason] as [string, string]] : []),
    ...(w.dueTitle ? [['Due', w.dueTitle] as [string, string]] : []),
    ['Date', lagosTime(w.at)],
    ['Reference', w.reference],
  ];
  // A completed withdrawal leads with the amount; the others with what happened.
  const body =
    w.outcome === 'success'
      ? `${emailHero(net)}
    <p>Hi ${escapeHtml(first)}, ${escapeHtml(w.viewerIsRequester ? 'you' : w.requestedBy)} sent this from ${escapeHtml(w.spaceName)} to ${escapeHtml(w.destination)}.</p>`
      : `<p>Hi ${escapeHtml(first)}, ${escapeHtml(copy.lead)}</p>`;
  const warning = "Don't recognise this withdrawal? Email support@duevy.app right away.";
  const html = renderEmail(
    `
    <h1>${copy.heading}</h1>
    ${body}
    ${emailDetails(rows.map(([k, v]) => [k, escapeHtml(v)] as [string, string]))}
    <a href="${w.link}" class="btn">View withdrawals</a>
    <p class="muted">${escapeHtml(warning)}</p>
  `,
    BRAND,
    { preheader: copy.lead },
  );
  const text =
    `Hi ${first},\n\n${copy.lead}\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nView withdrawals: ${w.link}\n\n${warning}`;
  return { subject: headerSafe(copy.subject), html, text };
}

export async function sendWithdrawalUpdateEmail(to: string, name: string, w: WithdrawalUpdate): Promise<void> {
  await sendEmail({ to, ...buildWithdrawalUpdateEmail(name, w) });
}

export type WithdrawalOtp = {
  code: string;
  spaceName: string;
  amountKobo: number;
  destination: string;
  dueTitle: string | null;
  requestedBy: string;
  reference: string;
  expiresInMinutes: number;
};

/** The one-time code a signatory enters to approve one withdrawal. Shows what
 *  they are approving, so a request they don't recognise stands out. */
export async function sendWithdrawalOtpEmail(to: string, name: string, w: WithdrawalOtp): Promise<void> {
  const amount = `₦${(w.amountKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  const rows: [string, string][] = [
    ['Space', escapeHtml(w.spaceName)],
    ['Amount', amount],
    ['To', escapeHtml(w.destination)],
    ...(w.dueTitle ? [['From due', escapeHtml(w.dueTitle)] as [string, string]] : []),
    ['Requested by', escapeHtml(w.requestedBy)],
    ['Reference', escapeHtml(w.reference)],
  ];
  const html = renderEmail(
    `
    <h1>Approve a withdrawal</h1>
    <p>Hi ${escapeHtml(firstName(name))}, enter this code on Duevy to approve the withdrawal below. It expires in ${w.expiresInMinutes} minutes.</p>
    ${emailHero(`<span style="letter-spacing:0.12em;">${escapeHtml(w.code)}</span>`)}
    ${emailDetails(rows)}
    <p class="muted">Don't share this code with anyone. Duevy will never ask you for it. If you don't recognise this withdrawal, reject it on the Payout page and email support@duevy.app.</p>
  `,
    BRAND,
    { preheader: `Your code to approve ${amount} from ${w.spaceName}.` },
  );
  await sendEmail({
    to,
    subject: headerSafe(`${w.code} is your Duevy approval code`),
    html,
    text: `Hi ${firstName(name)},\n\nYour code to approve the ${amount} withdrawal from ${w.spaceName} to ${w.destination} (${w.reference}) is ${w.code}. It expires in ${w.expiresInMinutes} minutes.\n\nDon't share this code with anyone. If you don't recognise this withdrawal, reject it on Duevy and email support@duevy.app.`,
  });
}

export type TransactionMilestone = {
  /** The milestone crossed, e.g. 1000. */
  milestone: number;
  /** Paid student payments so far (at least `milestone`). */
  payments: number;
  /** Everything students sent, fees included. */
  volumeKobo: number;
  /** What reached the spaces: the dues' face value. */
  netKobo: number;
  /** Duevy's processing fees on those payments. */
  feesKobo: number;
  /** Completed withdrawals and what they sent to departments' banks. */
  payouts: number;
  paidOutKobo: number;
  spaces: number;
  reps: number;
  students: number;
  campuses: number;
  /** When the first payment landed, and when the last milestone was crossed (null for the first). */
  firstPaymentAt: Date | null;
  previous: { milestone: number; at: Date } | null;
  at: Date;
  link: string;
};

const compactCount = (n: number) => n.toLocaleString('en-NG');
/** "1k", "2.5k", "10k", "1m". */
export function milestoneLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}
const days = (from: Date, to: Date) => Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
const plural = (n: number, word: string) => `${compactCount(n)} ${word}${n === 1 ? '' : 's'}`;

/** Subject, HTML and text celebrating a platform-wide payments milestone, for Duevy's team. */
/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 1,000th, 1,002nd. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${compactCount(n)}${suffix}`;
}

export function buildTransactionMilestoneEmail(name: string, m: TransactionMilestone) {
  const label = milestoneLabel(m.milestone);
  const net = nairaExact(m.netKobo);
  const pace = m.previous
    ? `, ${compactCount(m.milestone - m.previous.milestone)} of them in the ${plural(days(m.previous.at, m.at), 'day')} since we passed ${milestoneLabel(m.previous.milestone)}`
    : m.firstPaymentAt
      ? `, ${plural(days(m.firstPaymentAt, m.at), 'day')} after the first one`
      : '';
  const lead = `Duevy just processed its ${ordinal(m.milestone)} payment${pace}.`;
  const rows: [string, string][] = [
    ['Payments so far', compactCount(m.payments)],
    ['Net to spaces', net],
    ['Total volume', nairaExact(m.volumeKobo)],
    ['Processing fees', nairaExact(m.feesKobo)],
    ['Paid out to departments', `${nairaExact(m.paidOutKobo)} (${plural(m.payouts, 'withdrawal')})`],
    ['Spaces', compactCount(m.spaces)],
    ['Reps', compactCount(m.reps)],
    ['Students', compactCount(m.students)],
    ['Campuses', compactCount(m.campuses)],
  ];
  const first = firstName(name);
  const html = renderEmail(
    `
    <h1>Hurray, ${label} payments</h1>
    <p>Hi ${escapeHtml(first)}, ${escapeHtml(lead)}</p>
    ${emailDetails(rows)}
    <a href="${m.link}" class="btn">Open dashboard</a>
    <p class="muted">Duevy admins get this email each time payments pass a milestone.</p>
  `,
    BRAND,
    { preheader: `${compactCount(m.payments)} payments, ${net} to spaces.` },
  );
  const text = `Hi ${first},\n\n${lead}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nOpen dashboard: ${m.link}`;
  return { subject: headerSafe(`Hurray, Duevy has processed ${label} payments (${net} net)`), html, text };
}

export async function sendTransactionMilestoneEmail(to: string, name: string, m: TransactionMilestone): Promise<void> {
  await sendEmail({ to, ...buildTransactionMilestoneEmail(name, m) });
}

/** A rep inviting someone to sign up as a rep, with their referral link and code. */
export function buildReferralInviteEmail(inviterName: string, link: string, code: string) {
  const pitch = `Duevy lets department reps collect dues by bank transfer and see who has paid. ${inviterName} thinks you'd be a good rep for yours.`;
  const html = renderEmail(`
    <h1>${escapeHtml(inviterName)} invited you to Duevy</h1>
    <p>${escapeHtml(pitch)}</p>
    <a href="${link}" class="btn">Sign up as a rep</a>
    <p class="muted">Your referral code is ${escapeHtml(code)}.</p>
  `);
  return { subject: headerSafe(`${inviterName} invited you to be a rep on Duevy`), html, text: `${pitch}\n\nSign up: ${link}\nReferral code: ${code}` };
}

/** To the rep who reset their space's withdrawal code; withdrawals pause until `holdUntil`. */
export function buildWithdrawalPinResetEmail(name: string, spaceName: string, holdUntil: Date | null) {
  const pause = holdUntil ? ` Withdrawals are paused until ${lagosTime(holdUntil)}.` : '';
  const lead = `Hi ${firstName(name)}, the withdrawal code for ${spaceName} was just reset.${pause}`;
  const warning = "If you didn't do this, change your password and email support@duevy.app right away.";
  const html = renderEmail(`
    <h1>Your withdrawal code was reset</h1>
    <p>${escapeHtml(lead)}</p>
    <p>${escapeHtml(warning)}</p>
  `);
  return { subject: 'Your Duevy withdrawal code was reset', html, text: `${lead}\n\n${warning}` };
}

/** To every rep when a payout account is added to their space. */
export function buildNewBeneficiaryEmail(name: string, actorName: string, account: string) {
  const lead = `Hi ${firstName(name)}, ${actorName} added ${account} as a payout account for your space, so withdrawals can now be sent there.`;
  const warning = "If you didn't expect this, email support@duevy.app right away.";
  const html = renderEmail(`
    <h1>New payout account</h1>
    <p>${escapeHtml(lead)}</p>
    <p class="muted">${escapeHtml(warning)}</p>
  `);
  return { subject: 'A new payout account was added on Duevy', html, text: `${lead}\n\n${warning}` };
}
