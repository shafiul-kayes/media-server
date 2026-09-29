import crypto from 'node:crypto';
import { config } from '../config.js';

const hmac = (id, exp) => crypto.createHmac('sha256', config.signingSecret).update(`file:${id}:${exp}`).digest('base64url');

/** Returns query params granting temporary access to a private file. */
export function signParams(id, expiresInSeconds) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return { exp, sig: hmac(id, exp) };
}

export function verifySignature(id, exp, sig) {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const expected = Buffer.from(hmac(id, exp));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
