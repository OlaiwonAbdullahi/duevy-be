import bcrypt from 'bcryptjs';
import { db } from '../config/db';
import { env } from '../config/env';
import { signAccessToken, signRefreshToken } from '../lib/jwt';
import { generateId } from '../lib/id';
import { sendVerificationEmail, sendPasswordResetEmail } from '../lib/email';
import { randomBytes, createHash } from 'crypto';

function generateToken() {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createTokens(userId: string, role: string, spaceIds: string[], device?: string, ip?: string) {
  const jti = generateId('user'); // unique token id
  
  const accessToken = await signAccessToken({ sub: userId, role, spaceIds });
  const refreshToken = await signRefreshToken({ sub: userId, jti });
  
  await db.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30d
      device,
      ip,
    },
  });

  return { accessToken, refreshToken };
}

export async function sendVerification(userId: string, email: string, name: string) {
  const token = generateToken();
  const hashedToken = hashToken(token);
  
  await db.emailVerification.create({
    data: {
      userId,
      token: hashedToken, // Store hash in DB
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
    },
  });

  await sendVerificationEmail(email, name, token); // Send raw token
}

export async function sendPasswordReset(userId: string, email: string, name: string) {
  const token = generateToken();
  const hashedToken = hashToken(token);
  
  await db.passwordReset.create({
    data: {
      userId,
      tokenHash: hashedToken,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h
    },
  });

  await sendPasswordResetEmail(email, name, token);
}
