import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest } from '../errors.js';
import * as repo from '../repo.js';

export const SCOPES = ['upload', 'read', 'delete'];
export const KEY_RE = /^ms_[A-Za-z0-9_-]{43}$/;

/** Keys carry 256 bits of entropy, so a fast hash is sufficient (no need for bcrypt/argon2). */
export const hashKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export function parseScopes(value) {
  if (value === undefined) return SCOPES;
  const scopes = Array.isArray(value) ? value : String(value).split(',');
  const clean = [...new Set(scopes.map((s) => String(s).trim()).filter(Boolean))];
  if (!clean.length || clean.some((s) => !SCOPES.includes(s))) {
    throw badRequest(`scopes must be a non-empty subset of: ${SCOPES.join(', ')}`);
  }
  return clean;
}

export function parseName(value) {
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 100) throw badRequest('name is required (max 100 characters)');
  return name;
}

export function parseQuotaMb(value) {
  if (value === undefined) return config.defaultQuotaBytes;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw badRequest('quota_mb must be an integer between 1 and 10000000');
  return n * 1024 * 1024;
}

/** Creates a key and returns the plaintext secret. It is only shown once and never stored. */
export async function createApiKey({ name, scopes, quotaBytes, allowedOrigins = [] }) {
  const secret = `ms_${crypto.randomBytes(32).toString('base64url')}`;
  const id = `key_${crypto.randomBytes(8).toString('hex')}`;
  await repo.keys.create({
    id,
    name,
    keyHash: hashKey(secret),
    prefix: secret.slice(0, 7),
    scopes: scopes.join(','),
    quotaBytes,
    allowedOrigins: allowedOrigins.join(','),
    createdAt: Date.now(),
  });
  return { secret, key: await repo.keys.findById(id) };
}
