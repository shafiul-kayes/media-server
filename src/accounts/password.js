import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt parameters (OWASP-recommended minimum N=2^17 is heavier; 2^15 with r=8 keeps login
// under ~100 ms on modest servers while staying memory-hard). Stored with each hash so they
// can be raised later without breaking existing passwords.
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(stored, password) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts.map((v, i) => (i >= 1 && i <= 3 ? Number(v) : v));
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: n, r, p, maxmem: 128 * n * r * 2,
  });
  return crypto.timingSafeEqual(actual, expected);
}

let dummy;

/**
 * A real hash of a random password, verified against when the email does not exist so that
 * "unknown email" and "wrong password" take the same time (no user enumeration via timing).
 * Created lazily: a top-level await here would stop hosts that load the app with require()
 * (Hostinger/LiteSpeed) from starting it.
 */
export const getDummyHash = () => (dummy ??= hashPassword(crypto.randomBytes(16).toString('hex')));
