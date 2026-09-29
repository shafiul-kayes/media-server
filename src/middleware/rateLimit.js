import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

const MIN = 60 * 1000;

function limiter({ windowMs, limit, message, ...rest }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, error: { code: 'rate_limited', message } }),
    ...rest,
  });
}

const rl = config.rateLimit;

export const apiLimiter = limiter({
  windowMs: 15 * MIN,
  limit: rl.apiPer15Min,
  message: 'Too many requests, please slow down',
});

/** Counts only failed authentications, to stop API key / admin token brute forcing. */
export const authFailureLimiter = limiter({
  windowMs: 15 * MIN,
  limit: rl.authFailuresPer15Min,
  message: 'Too many failed authentication attempts',
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  skipSuccessfulRequests: true,
});

/** Per API key, so many clients behind one NAT do not share a budget. Must run after auth. */
export const uploadLimiter = limiter({
  windowMs: 60 * MIN,
  limit: rl.uploadsPerHour,
  message: 'Upload limit reached for this API key',
  keyGenerator: (req) => req.apiKey.id,
});

export const publicLimiter = limiter({
  windowMs: MIN,
  limit: rl.publicPerMin,
  message: 'Too many requests',
});

export const transformLimiter = limiter({
  windowMs: MIN,
  limit: rl.transformsPerMin,
  message: 'Too many image transformation requests',
});

/** Delete-link pages: tokens are unguessable, but cap guessing anyway. */
export const deletePageLimiter = limiter({
  windowMs: 15 * MIN,
  limit: rl.deletePagePer15Min,
  message: 'Too many requests',
});

export const adminLimiter = limiter({
  windowMs: 15 * MIN,
  limit: rl.adminPer15Min,
  message: 'Too many admin requests',
});
