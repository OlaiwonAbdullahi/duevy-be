import { Resend } from 'resend';
import { env } from '../config/env';
import { escapeHtml } from './html';

const resend = new Resend(env.RESEND_API_KEY);

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
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
  });

  if (error) {
    console.error('[email] Failed to send email:', error);
    throw new Error(`Email send failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

/** Public assets for emails — must be absolute and reachable from any inbox. */
const ASSET_BASE = 'https://www.duevy.app';
const BRAND = '#0b6e4f';
const BRAND_DEEP = '#08583f';
const INK = '#1b2520';
const INK_SOFT = '#7a847f';
const PAPER = '#f4f2ec';
const LINE = '#e6f2ec';
const BRAND_SOFT = '#eef6f2';
const FONT = "'Manrope', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Callers write plain `<h1>`, `<p>`, `<p class="muted">`, `class="btn"` and
 * `class="callout"`. Some clients (Gmail with non-Google accounts, Outlook)
 * drop `<style>` blocks, so stamp the same styles inline as well.
 */
function inlineStyles(content: string, tone: string): string {
  return content
    .replace(/<h1>/g, `<h1 style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;color:${INK};">`)
    .replace(/<p class="muted">/g, `<p class="muted" style="margin:0 0 16px;font-family:${FONT};font-size:13px;line-height:1.6;color:${INK_SOFT};">`)
    .replace(/<p>/g, `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.65;color:${INK};">`)
    .replace(/class="btn"/g, `class="btn" style="display:inline-block;background:${tone};color:#ffffff;border-radius:9999px;padding:14px 32px;font-family:${FONT};font-size:14px;font-weight:600;text-decoration:none;margin:4px 0 20px;"`)
    .replace(/class="callout"/g, `class="callout" style="background:${PAPER};border-radius:16px;padding:16px 18px;margin:0 0 20px;font-family:${FONT};font-size:14px;line-height:1.6;color:${INK};"`);
}

/**
 * A big-figure hero card (amount, code…) on the doodle artwork — e.g. the
 * amount on a receipt. Falls back to solid brand green where background images
 * aren't shown (Outlook).
 */
export function emailHero(label: string, value: string, caption?: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
      <tr>
        <td style="background:${BRAND_DEEP} url('${ASSET_BASE}/doodle-card.jpg') center / cover no-repeat;background-color:${BRAND_DEEP};border-radius:20px;padding:22px 24px;">
          <div style="font-family:${FONT};font-size:12px;color:rgba(255,255,255,0.78);">${label}</div>
          <div style="font-family:${FONT};font-size:32px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;color:#ffffff;margin-top:6px;">${value}</div>
          ${caption ? `<div style="font-family:${FONT};font-size:12px;color:rgba(255,255,255,0.78);margin-top:8px;">${caption}</div>` : ''}
        </td>
      </tr>
    </table>`;
}

/** Label/value rows in a soft panel — receipt details, account info. */
export function emailDetails(rows: [string, string][]): string {
  const body = rows
    .map(
      ([label, value], i) => `
      <tr>
        <td style="padding:12px 0;${i ? 'border-top:1px solid #e4e0d6;' : ''}font-family:${FONT};font-size:13px;color:${INK_SOFT};">${label}</td>
        <td align="right" style="padding:12px 0;${i ? 'border-top:1px solid #e4e0d6;' : ''}font-family:${FONT};font-size:13px;font-weight:600;color:${INK};word-break:break-all;">${value}</td>
      </tr>`,
    )
    .join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};border-radius:16px;margin:0 0 20px;">
      <tr><td style="padding:4px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
      </td></tr>
    </table>`;
}

/**
 * The shared email shell: a doodle-artwork header with the Duevy mark, the
 * content on a white card, and a quiet footer. `tone` colours the accent strip
 * and buttons (green by default; amber for resets, rose for warnings).
 * `preheader` is the inbox preview line.
 */
export function renderEmail(content: string, tone = BRAND, opts: { preheader?: string } = {}): string {
  const year = new Date().getFullYear();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Duevy</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap');
    body { margin: 0; padding: 0; background: ${PAPER}; -webkit-font-smoothing: antialiased; }
    a.btn:hover { opacity: 0.92; }
    @media (max-width: 600px) {
      .card-pad { padding-left: 22px !important; padding-right: 22px !important; }
      .outer-pad { padding: 16px 10px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${opts.preheader}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
    <tr>
      <td class="outer-pad" align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:24px;border:1px solid ${LINE};overflow:hidden;">
          <!-- Header: Duevy mark on the doodle artwork -->
          <tr>
            <td style="background:${BRAND_DEEP} url('${ASSET_BASE}/doodle-card.jpg') center / cover no-repeat;background-color:${BRAND_DEEP};padding:26px 32px;">
              <img src="${ASSET_BASE}/logos/duevy-logo-white.png" width="111" height="32" alt="Duevy" style="display:block;width:111px;height:32px;border:0;font-family:${FONT};font-size:20px;font-weight:600;color:#ffffff;" />
            </td>
          </tr>
          <!-- Accent strip in the email's tone -->
          <tr><td style="height:4px;line-height:4px;font-size:0;background:${tone};">&nbsp;</td></tr>
          <!-- Body -->
          <tr>
            <td class="card-pad" style="padding:32px 36px 16px;font-family:${FONT};color:${INK};">
              ${inlineStyles(content, tone)}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="card-pad" style="padding:20px 36px 28px;border-top:1px solid ${LINE};text-align:center;font-family:${FONT};font-size:12px;line-height:1.7;color:${INK_SOFT};">
              Need help? <a href="mailto:support@duevy.app" style="color:${BRAND};text-decoration:none;font-weight:600;">support@duevy.app</a><br />
              You're receiving this because it relates to your Duevy account.<br />
              © ${year} Duevy · <a href="${ASSET_BASE}" style="color:${INK_SOFT};text-decoration:underline;">duevy.app</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

export async function sendVerificationEmail(
  to: string,
  name: string,
  token: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/verify-email?token=${token}`;
  const html = renderEmail(`
    <h1>Verify your email</h1>
    <p>Hi ${escapeHtml(name)}, thanks for joining Duevy! Click the button below to verify your email address.</p>
    <a href="${link}" class="btn">Verify email</a>
    <p class="muted">This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
  `);

  await sendEmail({
    to,
    subject: 'Verify your Duevy email address',
    html,
    text: `Hi ${name},\n\nVerify your email: ${link}\n\nThis link expires in 24 hours.`,
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
    <p>Hi ${escapeHtml(name)}, we received a request to reset your Duevy password.</p>
    <a href="${link}" class="btn">Reset password</a>
    <p class="muted">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
  `,
    '#e8a33d',
  );

  await sendEmail({
    to,
    subject: 'Reset your Duevy password',
    html,
    text: `Hi ${name},\n\nReset your password: ${link}\n\nThis link expires in 1 hour.`,
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
};

const nairaExact = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One receipt card: the dues paid, then dues total, fee and the total paid. */
function emailReceiptCard(input: DuePaymentReceipt, amountPaid: string): string {
  const single = input.items.length === 1;
  const cell = `font-family:${FONT};font-size:14px;line-height:1.45;color:${INK};`;
  const items = input.items
    .map(
      (item, i) => `
      <tr>
        <td style="${cell}padding:12px 0;${i ? `border-top:1px solid ${LINE};` : ''}">${escapeHtml(item.title)}</td>
        <td align="right" style="${cell}padding:12px 0 12px 16px;${i ? `border-top:1px solid ${LINE};` : ''}font-weight:600;white-space:nowrap;vertical-align:top;">${nairaExact(item.amountKobo)}</td>
      </tr>`,
    )
    .join('');
  const total = (label: string, value: string) => `
      <tr>
        <td style="padding:4px 0;font-family:${FONT};font-size:13px;color:${INK_SOFT};">${label}</td>
        <td align="right" style="padding:4px 0;font-family:${FONT};font-size:13px;font-weight:600;color:${INK};white-space:nowrap;">${value}</td>
      </tr>`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:16px;margin:0 0 20px;border-collapse:separate;">
      <tr>
        <td style="padding:14px 18px;background:${PAPER};border-radius:16px 16px 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${INK_SOFT};">${single ? 'Due paid' : `Dues paid (${input.items.length})`}</td>
              <td align="right" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${INK_SOFT};">Amount</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:2px 18px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px 6px;border-top:1px solid ${LINE};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${total(single ? 'Due amount' : 'Dues total', nairaExact(input.faceKobo))}
            ${total('Service fee', nairaExact(input.feeKobo))}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:6px 10px 10px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_SOFT};border-radius:12px;">
            <tr>
              <td style="padding:12px 8px 12px 12px;font-family:${FONT};font-size:14px;font-weight:700;color:${INK};">Total paid</td>
              <td align="right" style="padding:12px 12px 12px 8px;font-family:${FONT};font-size:17px;font-weight:700;color:${BRAND};white-space:nowrap;">${amountPaid}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
}

/** Subject, HTML and text for a dues payment receipt — one due or a basket of many. */
export function buildDuePaymentReceiptEmail(name: string, input: DuePaymentReceipt) {
  const amount = nairaExact(input.amountPaidKobo);
  // The app's payment page shows the full receipt and its PDF download (behind sign-in).
  const receiptLink = `${env.FRONTEND_URL}/dashboard/pay/${encodeURIComponent(input.reference)}`;
  const paidAt = input.paidAt.toLocaleString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Lagos',
  });
  const single = input.items.length === 1;
  const summary = single ? input.items[0]!.title : `${input.items.length} dues`;
  const spaceName = escapeHtml(input.spaceName);
  const intro = single
    ? `your payment for <strong>${escapeHtml(summary)}</strong>${spaceName ? ` to ${spaceName}` : ''} went through.`
    : `your payment for <strong>${input.items.length} dues</strong>${spaceName ? ` to ${spaceName}` : ''} went through — every one of them is now marked paid.`;

  const html = renderEmail(
    `
    <h1>Payment confirmed</h1>
    <p>Hi ${escapeHtml(name)}, ${intro} Here's your receipt.</p>
    ${emailHero('Total paid', amount, `<span style="display:inline-block;background:#ffffff;color:${BRAND};border-radius:9999px;padding:2px 10px;font-size:11px;font-weight:700;letter-spacing:0.06em;margin-right:8px;">PAID</span>${paidAt}`)}
    ${emailReceiptCard(input, amount)}
    ${emailDetails([
      ...(input.receiptNumber ? ([['Receipt no.', escapeHtml(input.receiptNumber)]] as [string, string][]) : []),
      ...(spaceName ? ([['Paid to', spaceName]] as [string, string][]) : []),
      ['Paid by', escapeHtml(name)],
      ['Method', 'Bank transfer'],
      ['Reference', escapeHtml(input.reference)],
    ])}
    <a href="${receiptLink}" class="btn">View receipt</a>
    <p class="muted">Keep this email as proof of payment. ${spaceName || 'Your department'} receives the full ${nairaExact(input.faceKobo)}; the service fee is 2% + ₦20 per payment. Questions? Reply here or reach us at support@duevy.app</p>
  `,
    undefined,
    { preheader: `${amount} paid for ${summary} — your receipt is inside.` },
  );

  const lines = input.items.map((i) => `- ${i.title}: ${nairaExact(i.amountKobo)}`).join('\n');
  const text =
    `Hi ${name},\n\nYour payment of ${amount}${input.spaceName ? ` to ${input.spaceName}` : ''} is confirmed.\n\n` +
    `${single ? 'Due paid' : `Dues paid (${input.items.length})`}:\n${lines}\n\n` +
    `${single ? 'Due amount' : 'Dues total'}: ${nairaExact(input.faceKobo)}\nService fee: ${nairaExact(input.feeKobo)}\nTotal paid: ${amount}\n\n` +
    `${input.receiptNumber ? `Receipt no.: ${input.receiptNumber}\n` : ''}Reference: ${input.reference}\nMethod: Bank transfer\nDate: ${paidAt}\n\n` +
    `View your receipt: ${receiptLink}`;

  return { subject: `Payment confirmed — ${summary}`, html, text };
}

export async function sendDuePaymentReceiptEmail(to: string, name: string, input: DuePaymentReceipt): Promise<void> {
  await sendEmail({ to, ...buildDuePaymentReceiptEmail(name, input) });
}

export async function sendRepApplicationReceivedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const html = renderEmail(`
    <h1>Application received</h1>
    <p>Hi ${escapeHtml(name)}, your rep application for <strong>${escapeHtml(spaceName)}</strong> is under review.</p>
    <p>Our team will verify your application within 1–2 business days. You'll get an email once a decision is made.</p>
    <p class="muted">Questions? Reply to this email or reach us at support@duevy.app</p>
  `);

  await sendEmail({
    to,
    subject: 'Your Duevy rep application is under review',
    html,
  });
}

/** Nudges for a rep applicant who hasn't finished verification (stage 1–3). */
export async function sendKycReminderEmail(to: string, name: string, stage: 1 | 2 | 3): Promise<void> {
  const link = `${env.FRONTEND_URL}/onboarding`;
  const first = escapeHtml(name.split(' ')[0]);
  const copy = {
    1: {
      subject: 'Finish setting up your Duevy rep account',
      heading: 'You\'re almost there',
      body: `Hi ${first}, thanks for signing up as a rep on Duevy. One step is left: verify your identity so your department can start collecting dues. It takes about three minutes.`,
    },
    2: {
      subject: 'Your department is waiting — finish your Duevy verification',
      heading: 'Your department can\'t collect dues yet',
      body: `Hi ${first}, your rep account still needs verification. Until it's done, your department can't collect dues on Duevy. You'll need your NIN, your student ID card and your bank account.`,
    },
    3: {
      subject: 'Last reminder: complete your Duevy rep verification',
      heading: 'Last reminder',
      body: `Hi ${first}, it's been a week since you signed up as a rep and your verification still isn't complete. Finish it now to get your department collecting dues — or reply to this email if something's in the way and we'll help.`,
    },
  }[stage];

  const html = renderEmail(
    `
    <h1>${copy.heading}</h1>
    <p>${copy.body}</p>
    <a href="${link}" class="btn">Complete verification</a>
    <p class="muted">Already done? You can ignore this email.</p>
  `,
    BRAND,
    { preheader: 'Verify your NIN, student ID and payout account in about three minutes.' },
  );

  await sendEmail({ to, subject: copy.subject, html });
}

export async function sendRepApprovedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/dashboard`;
  const html = renderEmail(`
    <h1>You're approved! 🎉</h1>
    <p>Hi ${escapeHtml(name)}, your rep application for <strong>${escapeHtml(spaceName)}</strong> has been approved.</p>
    <p>You can now access your rep dashboard and start managing dues.</p>
    <a href="${link}" class="btn">Go to dashboard</a>
  `);

  await sendEmail({
    to,
    subject: 'Your Duevy rep application has been approved',
    html,
  });
}

export async function sendRepRejectedEmail(
  to: string,
  name: string,
  reason: string,
): Promise<void> {
  const html = renderEmail(
    `
    <h1>Application update</h1>
    <p>Hi ${escapeHtml(name)}, we reviewed your rep application and unfortunately couldn't approve it at this time.</p>
    <div class="callout"><strong>Reason:</strong> ${escapeHtml(reason)}</div>
    <p>Your account has been set up as a student account. If you believe this is a mistake, please contact us at support@duevy.app</p>
  `,
    '#b01e4e',
  );

  await sendEmail({
    to,
    subject: 'Update on your Duevy rep application',
    html,
  });
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
    <p>Hi ${escapeHtml(name.split(' ')[0] ?? name)}, enter this code on Duevy to approve the withdrawal below.</p>
    ${emailHero('Your approval code', w.code, `Expires in ${w.expiresInMinutes} minutes`)}
    ${emailDetails(rows)}
    <p class="muted">Never share this code — Duevy will never ask you for it. If you don't recognise this withdrawal, reject it on the Payout page and contact support@duevy.app.</p>
  `,
    BRAND,
    { preheader: `Approval code for a ${amount} withdrawal from ${w.spaceName}` },
  );
  await sendEmail({
    to,
    subject: headerSafe(`${w.code} is your Duevy withdrawal approval code`),
    html,
    text: `Hi ${name},\n\nYour code to approve the ${amount} withdrawal from ${w.spaceName} to ${w.destination} (${w.reference}) is ${w.code}. It expires in ${w.expiresInMinutes} minutes.\n\nNever share this code. If you don't recognise this withdrawal, reject it on Duevy and contact support@duevy.app.`,
  });
}
