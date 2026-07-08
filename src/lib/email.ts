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

function baseTemplate(content: string, tone = '#0b6e4f'): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Duevy</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&display=swap');
    body { margin: 0; padding: 0; background: #fbfaf7; font-family: 'Manrope', 'Helvetica Neue', Arial, sans-serif; color: #1b2520; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .top-bar { height: 4px; background: ${tone}; }
    .body { padding: 40px 36px; }
    .logo { font-size: 18px; font-weight: 400; color: #1b2520; margin-bottom: 28px; }
    .logo span { font-weight: 700; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #1b2520; }
    p { font-size: 15px; line-height: 1.6; color: #1b2520; margin: 0 0 16px; }
    p.muted { color: #7a847f; font-size: 13px; }
    .btn { display: inline-block; background: #0b6e4f; color: #ffffff !important; border-radius: 9999px; padding: 12px 28px; font-size: 14px; font-weight: 600; text-decoration: none; margin: 8px 0 20px; }
    .divider { border: none; border-top: 1px solid #e6f2ec; margin: 24px 0; }
    .footer { padding: 20px 36px 32px; text-align: center; font-size: 12px; color: #7a847f; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="top-bar"></div>
    <div class="body">
      <div class="logo"><span>Duevy.</span></div>
      ${content}
    </div>
    <hr class="divider" />
    <div class="footer">Duevy — duevy.app · @duevyapp</div>
  </div>
</body>
</html>`.trim();
}

export async function sendVerificationEmail(
  to: string,
  name: string,
  token: string,
): Promise<void> {
  const link = `${env.FRONTEND_URL}/verify-email?token=${token}`;
  const html = baseTemplate(`
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
  const html = baseTemplate(
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

export async function sendRepApplicationReceivedEmail(
  to: string,
  name: string,
  spaceName: string,
): Promise<void> {
  const html = baseTemplate(`
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
  const html = baseTemplate(`
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
  const html = baseTemplate(
    `
    <h1>Application update</h1>
    <p>Hi ${name}, we reviewed your rep application and unfortunately couldn't approve it at this time.</p>
    <p><strong>Reason:</strong> ${reason}</p>
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
