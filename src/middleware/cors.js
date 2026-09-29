import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { originMatches, splitOrigins } from '../services/origins.js';

/**
 * CORS for the key-authenticated API.
 *
 * A preflight cannot carry the API key, so the browser-facing headers reflect any Origin. This is
 * safe because the API never uses cookies or other ambient credentials: the only authority is the
 * API key, and `enforceOrigin` then rejects requests whose Origin is not on that key's allow-list.
 */
export function apiCors(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();

  res.vary('Origin');
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Expose-Headers', 'RateLimit, RateLimit-Policy, Retry-After');
  if (req.method === 'OPTIONS') {
    res.set({
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Max-Age': '600',
    });
    return res.status(204).end();
  }
  next();
}

function ownOrigins(req) {
  return [new URL(config.baseUrl).origin, `${req.protocol}://${req.get('host')}`];
}

/**
 * Browser requests (those with an Origin header) are only allowed from the key's `allowed_origins`,
 * the global CORS_ORIGINS list, or this server itself (the /docs page). Server-to-server calls
 * send no Origin and are unaffected.
 */
export function enforceOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin || ownOrigins(req).includes(origin)) return next();
  const patterns = [...config.corsOrigins, ...splitOrigins(req.apiKey.allowed_origins)];
  if (patterns.some((p) => originMatches(p, origin))) return next();
  next(new HttpError(403, 'origin_not_allowed', `Origin ${origin} is not in this API key's allowed_origins`));
}
