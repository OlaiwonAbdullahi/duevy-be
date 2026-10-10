import { Resend } from 'resend';
import { env } from '../config/env';

const resend = new Resend(env.RESEND_API_KEY);

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: Array.isArray(options.to) ? options.to : [options.to],
    subject: options.subject,
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
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${ASSET_BASE}/icons/icon-192.png" width="36" height="36" alt="Duevy" style="display:block;width:36px;height:36px;border-radius:10px;border:0;" />
                  </td>
                  <td style="vertical-align:middle;padding-left:10px;font-family:${FONT};font-size:20px;font-weight:600;letter-spacing:-0.01em;color:#ffffff;">Duevy.</td>
                </tr>
              </table>
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
    <p>Hi ${name}, thanks for joining Duevy! Click the button below to verify your email address.</p>
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
    <p>Hi ${name}, we received a request to reset your Duevy password.</p>
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

export async function sendDuePaymentReceiptEmail(
  to: string,
  name: string,
  input: { dueTitle: string; spaceName: string; amountPaidKobo: number; reference: string; dueId: string },
): Promise<void> {
  const amount = `₦${(input.amountPaidKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  const receiptLink = `${env.APP_BASE_URL}/v1/dues/${input.dueId}/receipt`;
  const paidAt = new Date().toLocaleString('en-NG', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
  const html = renderEmail(
    `
    <h1>Payment confirmed</h1>
    <p>Hi ${name}, your payment for <strong>${input.dueTitle}</strong> went through. Here's your receipt.</p>
    ${emailHero('Amount paid', amount, input.spaceName)}
    ${emailDetails([
      ['Due', input.dueTitle],
      ['Space', input.spaceName],
      ['Reference', input.reference],
      ['Date', paidAt],
      ['Status', 'Paid'],
    ])}
    <a href="${receiptLink}" class="btn">Download receipt</a>
    <p class="muted">Keep this email as proof of payment. Questions? Reply here or reach us at support@duevy.app</p>
  `,
    undefined,
    { preheader: `${amount} paid for ${input.dueTitle} — your receipt is inside.` },
  );

  await sendEmail({
    to,
    subject: `Payment confirmed — ${input.dueTitle}`,
    html,
    text: `Hi ${name},\n\nYour payment of ${amount} for ${input.dueTitle} (${input.spaceName}) is confirmed.\nReference: ${input.reference}\n\nView your receipt: ${receiptLink}`,
  });
}

export async function sendRepApplicationReceivedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const html = renderEmail(`
    <h1>Application received</h1>
    <p>Hi ${name}, your rep application for <strong>${spaceName}</strong> is under review.</p>
    <p>Our team will verify your application within 1–2 business days. You'll get an email once a decision is made.</p>
    <p class="muted">Questions? Reply to this email or reach us at support@duevy.app</p>
  `);

  await sendEmail({
    to,
    subject: 'Your Duevy rep application is under review',
    html,
  });
}

export async function sendRepApprovedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/dashboard`;
  const html = renderEmail(`
    <h1>You're approved! 🎉</h1>
    <p>Hi ${name}, your rep application for <strong>${spaceName}</strong> has been approved.</p>
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
    <p>Hi ${name}, we reviewed your rep application and unfortunately couldn't approve it at this time.</p>
    <div class="callout"><strong>Reason:</strong> ${reason}</div>
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
