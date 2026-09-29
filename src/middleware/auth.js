import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import * as repo from '../repo.js';
import { KEY_RE, hashKey } from '../services/apiKeys.js';

const unauthorized = () => new HttpError(401, 'unauthorized', 'Missing or invalid API key');

function bearer(req) {
  const header = req.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : undefined;
}

/**
 * Reads the API key from `X-API-Key` / `Authorization: Bearer`. The imgbb-compatible endpoint
 * additionally accepts `?key=` and a `key` body field, like imgbb does.
 */
export function readKey(req, { query = false, body = false } = {}) {
  const fromHeader = req.get('x-api-key') || bearer(req);
  if (fromHeader) return fromHeader;
  if (query && typeof req.query.key === 'string') return req.query.key;
  if (body && typeof req.body?.key === 'string') return req.body.key;
  return undefined;
}

export async function authenticate(raw) {
  if (!raw || !KEY_RE.test(raw)) throw unauthorized();
  const key = await repo.keys.findByHash(hashKey(raw));
  if (!key || !key.active || key.owner_status === 'suspended') throw unauthorized();

  const now = Date.now();
  if (!key.last_used_at || now - key.last_used_at > 60_000) await repo.keys.touch(key.id, now);
  return key;
}

/** Header-only authentication for the native API. */
export async function apiKeyAuth(req, res, next) {
  req.apiKey = await authenticate(readKey(req));
  next();
}

/** Authenticates from header/query/body; skips if a key was already resolved earlier in the chain. */
export const apiKeyAuthFrom = (sources) => async (req, res, next) => {
  if (!req.apiKey) req.apiKey = await authenticate(readKey(req, sources));
  next();
};

export const requireScope = (scope) => (req, res, next) => {
  if (!req.apiKey?.scopes.split(',').includes(scope)) {
    return next(new HttpError(403, 'forbidden', `This API key lacks the "${scope}" scope`));
  }
  next();
};

const digest = (value) => crypto.createHash('sha256').update(value).digest();

export function adminAuth(req, res, next) {
  const token = bearer(req);
  // Comparing fixed-length digests keeps the comparison constant-time regardless of input length.
  if (!token || !crypto.timingSafeEqual(digest(token), digest(config.adminToken))) {
    return next(new HttpError(401, 'unauthorized', 'Invalid admin token'));
  }
  next();
}
