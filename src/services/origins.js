import { badRequest } from '../errors.js';

const ORIGIN_RE = /^(https?):\/\/(\*\.)?([a-z0-9-]+(\.[a-z0-9-]+)*)(:\d{1,5})?$/;
const MAX_ORIGINS = 50;

/** Accepts `*`, `https://example.com`, `http://localhost:5173` or `https://*.example.com`. */
export function normalizeOrigin(value) {
  const origin = String(value).trim().replace(/\/+$/, '').toLowerCase();
  if (origin === '*') return origin;
  if (!ORIGIN_RE.test(origin)) {
    throw badRequest(`Invalid origin "${value}". Use e.g. https://example.com or https://*.example.com`);
  }
  return origin;
}

/** Parses an array or comma separated string. Returns undefined when not provided. */
export function parseOrigins(value) {
  if (value === undefined) return undefined;
  const items = (Array.isArray(value) ? value : String(value).split(',')).map(String).filter((s) => s.trim());
  if (items.length > MAX_ORIGINS) throw badRequest(`At most ${MAX_ORIGINS} allowed origins`);
  return [...new Set(items.map(normalizeOrigin))];
}

export const splitOrigins = (stored) => (stored ? stored.split(',') : []);

export function originMatches(pattern, origin) {
  if (pattern === '*') return true;
  const candidate = origin.toLowerCase();
  if (!pattern.includes('://*.')) return pattern === candidate;
  // https://*.example.com matches https://a.example.com and https://a.b.example.com, not https://example.com.
  const [scheme, rest] = pattern.split('://');
  const suffix = rest.slice(1); // ".example.com[:port]"
  const prefix = `${scheme}://`;
  return (
    candidate.startsWith(prefix) &&
    candidate.endsWith(suffix) &&
    candidate.length > prefix.length + suffix.length &&
    !candidate.slice(prefix.length, -suffix.length).includes(':')
  );
}
