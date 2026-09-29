import crypto from 'node:crypto';
import { config } from '../config.js';
import { sendMail, sendMailInBackground } from '../mail/mailer.js';
import * as templates from '../mail/templates.js';
import { tokens } from './repo.js';

/**
 * One-time tokens sent by email (verification, password reset, invitations).
 *  - 256-bit random, sent only to the user's mailbox; the database stores only a SHA-256.
 *  - Short expiry, single use (atomic UPDATE), and older reset links die when a new one is sent.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const ttlMs = {
  verify_email: () => config.accounts.verifyTokenHours * 3600_000,
  reset_password: () => config.accounts.resetTokenMinutes * 60_000,
  invite: () => config.accounts.inviteTokenDays * 86400_000,
};

export async function issueToken(userId, purpose, ip = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  await tokens.create({ idHash: sha256(token), userId, purpose, expiresAt: Date.now() + ttlMs[purpose](), ip: ip?.slice(0, 45) ?? null });
  return token;
}

/** Returns the token row (with user fields) if it exists, is unused and not expired. */
export async function findValidToken(token, purposes) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
  const row = await tokens.find(sha256(token), purposes);
  if (!row || row.used_at || row.expires_at <= Date.now()) return undefined;
  return { ...row, idHash: sha256(token) };
}

export const consumeToken = (row) => tokens.consume(row.idHash);

const HOUR = 3600_000;

/**
 * Sends a verification email unless one was sent in the last minute or five in the last hour.
 * Returns false when throttled.
 */
export async function sendVerificationEmail(user, ip) {
  const { count, latest } = await tokens.countSince(user.id, 'verify_email', Date.now() - HOUR);
  if (count >= 5 || (latest && Date.now() - latest < 60_000)) return false;
  await tokens.invalidate(user.id, ['verify_email']);
  const token = await issueToken(user.id, 'verify_email', ip);
  sendMailInBackground({ to: user.email, ...templates.verifyEmail({ name: user.name, token }) });
  return true;
}

/** Sends a reset link, at most three per hour per account. Earlier reset links stop working. */
export async function sendPasswordResetEmail(user, ip) {
  const { count } = await tokens.countSince(user.id, 'reset_password', Date.now() - HOUR);
  if (count >= 3) return false;
  await tokens.invalidate(user.id, ['reset_password']);
  const token = await issueToken(user.id, 'reset_password', ip);
  sendMailInBackground({ to: user.email, ...templates.resetPassword({ name: user.name, token }) });
  return true;
}

/** Sends an invitation (set-your-password link). Awaited, so the caller can report delivery failures. */
export async function sendInvitation(user, { role, invitedBy, ip }) {
  await tokens.invalidate(user.id, ['invite', 'reset_password']);
  const token = await issueToken(user.id, 'invite', ip);
  try {
    await sendMail({ to: user.email, ...templates.invitation({ name: user.name, role, invitedBy, token }) });
    return { sent: true, token };
  } catch (err) {
    console.error(`[mail] invitation to user ${user.id} failed: ${err.message}`);
    return { sent: false, token };
  }
}
