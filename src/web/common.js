import { rateLimit } from 'express-rate-limit';
import { audit } from '../accounts/repo.js';
import { config } from '../config.js';
import { errorPage, sendHtml } from './html.js';

const MIN = 60_000;
const rl = config.rateLimit;

function pageLimiter({ windowMs, limit, message, ...rest }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => sendHtml(res, 429, errorPage(req, 429, message)),
    ...rest,
  });
}

/** Counts only failed logins (rendered with 401), per IP. */
export const loginLimiter = pageLimiter({
  windowMs: 15 * MIN,
  limit: rl.loginFailuresPer15Min,
  message: 'অনেকবার ভুল লগইন চেষ্টা হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।',
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
});

export const registerLimiter = pageLimiter({
  windowMs: 60 * MIN,
  limit: rl.registrationsPerHour,
  message: 'এই নেটওয়ার্ক থেকে অনেকগুলো অ্যাকাউন্ট খোলা হয়েছে। পরে আবার চেষ্টা করুন।',
  skip: (req) => req.method !== 'POST',
});

export const panelLimiter = pageLimiter({
  windowMs: 15 * MIN,
  limit: rl.panelPer15Min,
  message: 'খুব দ্রুত অনেক রিকোয়েস্ট হয়েছে। একটু পর আবার চেষ্টা করুন।',
});

/** Writes an audit entry; never lets a logging failure break the user's action. */
export async function logAudit(req, action, target = null, details = null) {
  try {
    await audit.log({ actorId: req.user?.id ?? null, action, target, details, ip: req.ip?.slice(0, 45) ?? null });
  } catch (err) {
    console.error('[audit] failed to write', action, err.message);
  }
}

export const toPage = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
};

/** Parses a numeric route id; anything else becomes 0, which matches no row. */
export const toId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : 0);
