import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { isOwnOrigin } from '../services/ownOrigin.js';
import { sessions } from './repo.js';

/**
 * Cookie sessions for the web panel.
 *  - The cookie holds a random 256-bit token; the database stores only its SHA-256, so a
 *    leaked database cannot be used to hijack sessions.
 *  - HttpOnly + SameSite=Lax, and Secure with the `__Host-` prefix when served over https.
 *  - Idle timeout and absolute lifetime; a new token on every login (no session fixation).
 */

const secure = config.baseUrl.startsWith('https://');
export const SESSION_COOKIE = secure ? '__Host-ms_session' : 'ms_session';
const PRE_CSRF_COOKIE = secure ? '__Host-ms_csrf' : 'ms_csrf';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const HOUR = 3600_000;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const cookieOptions = (maxAge) => ({ httpOnly: true, secure, sameSite: 'lax', path: '/', ...(maxAge ? { maxAge } : {}) });

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export async function startSession(req, res, user) {
  const token = newToken();
  const maxAge = config.accounts.sessionMaxDays * 24 * HOUR;
  await sessions.create({
    idHash: sha256(token),
    userId: user.id,
    csrfToken: newToken(),
    ip: req.ip?.slice(0, 45) ?? null,
    userAgent: (req.get('user-agent') || '').slice(0, 255),
    expiresAt: Date.now() + maxAge,
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions(maxAge));
  res.clearCookie(PRE_CSRF_COOKIE, cookieOptions());
}

export async function endSession(req, res) {
  if (req.session) await sessions.remove(req.session.id);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** Resolves the session cookie into `req.user` / `req.session` (both undefined when logged out). */
export async function loadSession(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const token = req.cookies[SESSION_COOKIE];
  if (token && TOKEN_RE.test(token)) {
    const session = await sessions.find(sha256(token));
    const now = Date.now();
    const valid = session
      && session.expires_at > now
      && now - session.last_seen_at < config.accounts.sessionIdleHours * HOUR
      && session.status === 'active';
    if (valid) {
      req.session = session;
      req.user = {
        id: session.user_id,
        name: session.name,
        email: session.email,
        role: session.role,
        emailVerified: Boolean(session.email_verified_at),
      };
      if (now - session.last_seen_at > 60_000) await sessions.touch(session.id);
    } else {
      if (session) await sessions.remove(session.id);
      res.clearCookie(SESSION_COOKIE, cookieOptions());
    }
  }
  next();
}

/** Only allows relative, same-site paths as post-login redirect targets (no open redirects). */
export function safeNext(value, fallback) {
  return typeof value === 'string' && /^\/(?![/\\])[\w\-./?=&%]*$/.test(value) ? value : fallback;
}

export function requireUser(req, res, next) {
  if (req.user) return next();
  res.redirect(303, `/login?next=${encodeURIComponent(safeNext(req.originalUrl, '/account'))}`);
}

/** True when the account may use features gated behind a verified email. */
export const isVerified = (user) => !config.accounts.requireEmailVerification || Boolean(user?.emailVerified);

export function requireAdmin(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (req.user.role !== 'admin') return next(new HttpError(403, 'forbidden', 'এই পেজ শুধু অ্যাডমিনের জন্য'));
  if (!isVerified(req.user)) {
    return next(new HttpError(403, 'unverified', 'অ্যাডমিন প্যানেল ব্যবহারের আগে ইমেইল যাচাই করুন। ড্যাশবোর্ড থেকে যাচাই ইমেইল আবার পাঠাতে পারবেন।'));
  }
  next();
}

// ---- CSRF -----------------------------------------------------------------------------------------

/**
 * Token for the current form. Logged-in users get their session's synchronizer token; login and
 * registration forms (no session yet) use a double-submit cookie.
 */
export function csrfToken(req, res) {
  if (req.session) return req.session.csrf_token;
  let token = req.cookies?.[PRE_CSRF_COOKIE];
  if (!token || !TOKEN_RE.test(token)) {
    token = newToken();
    res.cookie(PRE_CSRF_COOKIE, token, cookieOptions(2 * HOUR));
    req.cookies[PRE_CSRF_COOKIE] = token;
  }
  return token;
}

function isSameOrigin(req) {
  const origin = req.get('origin');
  if (origin) return isOwnOrigin(req, origin);
  const referer = req.get('referer');
  if (referer) return isOwnOrigin(req, referer);
  return true; // some privacy tools strip both headers; the token check below still applies
}

/** Rejects cross-site POSTs: Origin/Referer must be ours AND the form token must match. */
export function verifyCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const expected = req.session ? req.session.csrf_token : req.cookies?.[PRE_CSRF_COOKIE];
  const given = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
  const ok = isSameOrigin(req)
    && expected
    && given.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return next(new HttpError(403, 'csrf', 'ফর্মের মেয়াদ শেষ বা অনুরোধটি বৈধ নয়। পেজটি রিফ্রেশ করে আবার চেষ্টা করুন।'));
  next();
}
