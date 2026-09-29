import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { hashPassword } from '../accounts/password.js';
import { sessions, tokens, users } from '../accounts/repo.js';
import { csrfToken } from '../accounts/session.js';
import { consumeToken, findValidToken, sendPasswordResetEmail } from '../accounts/tokens.js';
import { normalizeEmail, validatePassword } from '../accounts/validate.js';
import { config } from '../config.js';
import { sendMailInBackground } from '../mail/mailer.js';
import * as templates from '../mail/templates.js';
import { logAudit } from './common.js';
import { authPage, bn, csrfField, errorPage, field, html, sendHtml } from './html.js';

export const router = express.Router();

// Pages carrying a token in the URL must not leak it through the Referer header.
const NO_REFERRER = { 'Referrer-Policy': 'no-referrer' };

const forgotLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.rateLimit.passwordResetsPer15Min,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
  handler: (req, res) => sendHtml(res, 429, errorPage(req, 429, 'অনেকবার চেষ্টা হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।')),
});

const invalidLink = (req, res, what) => sendHtml(res, 400, authPage(req, {
  title: 'লিংকটি কাজ করছে না',
  body: html`<section class="auth-card card center">
  <h1>লিংকটি কাজ করছে না</h1>
  <p class="muted">এই ${what} লিংকটি ভুল, মেয়াদোত্তীর্ণ, অথবা আগেই ব্যবহার করা হয়েছে।</p>
  <p><a class="btn btn-primary" href="${what === 'যাচাই' ? '/account' : '/forgot-password'}">${what === 'যাচাই' ? 'ড্যাশবোর্ড থেকে নতুন লিংক নিন' : 'নতুন লিংক চান'}</a></p>
</section>`,
}), NO_REFERRER);

// ---- Forgot password ------------------------------------------------------------------------------

function forgotPage(req, res, status, { sent = false, email = '' } = {}) {
  const token = csrfToken(req, res);
  sendHtml(res, status, authPage(req, {
    title: 'পাসওয়ার্ড ভুলে গেছেন',
    body: sent
      ? html`<section class="auth-card card center">
  <div class="big-icon" aria-hidden="true">✉</div>
  <h1>ইমেইল দেখুন</h1>
  <p>যদি <strong>${email}</strong> দিয়ে কোনো অ্যাকাউন্ট থাকে, তাহলে পাসওয়ার্ড রিসেটের লিংক পাঠানো হয়েছে। লিংকটি ${bn(config.accounts.resetTokenMinutes)} মিনিট কাজ করবে।</p>
  <p class="muted">ইমেইল না পেলে স্প্যাম ফোল্ডার দেখুন, অথবা কয়েক মিনিট পর আবার চেষ্টা করুন।</p>
  <p><a href="/login">লগইনে ফিরে যান</a></p>
</section>`
      : html`<section class="auth-card card">
  <h1>পাসওয়ার্ড ভুলে গেছেন?</h1>
  <p class="muted">অ্যাকাউন্টের ইমেইল দিন। পাসওয়ার্ড রিসেট করার একটি লিংক পাঠিয়ে দেব।</p>
  <form method="post" action="/forgot-password">
    ${csrfField(token)}
    ${field({ name: 'email', label: 'ইমেইল', type: 'email', value: email, required: true, attrs: { autocomplete: 'email', autofocus: 'autofocus', maxlength: 254 } })}
    <button class="btn btn-primary btn-block" type="submit">রিসেট লিংক পাঠান</button>
  </form>
  <p class="center muted"><a href="/login">লগইনে ফিরে যান</a></p>
</section>`,
  }));
}

router.get('/forgot-password', (req, res) => forgotPage(req, res, 200));

router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email).slice(0, 254);
  const user = email ? await users.findByEmail(email) : undefined;
  // Same response whether or not the account exists, and the email is sent in the background,
  // so neither the page nor its timing reveals which addresses are registered.
  if (user && user.status === 'active') {
    const sent = await sendPasswordResetEmail(user, req.ip);
    if (sent) await logAudit({ ip: req.ip }, 'user.password_reset_request', `user:${user.id}`);
  }
  forgotPage(req, res, 200, { sent: true, email });
});

// ---- Reset password / accept invitation ------------------------------------------------------------

const RESET_PURPOSES = ['reset_password', 'invite'];

function resetPage(req, res, status, row, { errors = {} } = {}) {
  const csrf = csrfToken(req, res);
  const invite = row.purpose === 'invite';
  sendHtml(res, status, authPage(req, {
    title: invite ? 'পাসওয়ার্ড সেট করুন' : 'নতুন পাসওয়ার্ড',
    body: html`<section class="auth-card card">
  <h1>${invite ? 'অ্যাকাউন্ট চালু করুন' : 'নতুন পাসওয়ার্ড সেট করুন'}</h1>
  <p class="muted">${invite ? html`স্বাগতম, ${row.name}! ` : ''}অ্যাকাউন্ট: <strong>${row.email}</strong></p>
  <form method="post" action="/reset-password" novalidate>
    ${csrfField(csrf)}
    <input type="hidden" name="token" value="${req.body?.token ?? req.query.token}">
    <input type="email" name="username" value="${row.email}" autocomplete="username" hidden>
    ${field({ name: 'password', label: 'নতুন পাসওয়ার্ড', type: 'password', errors, required: true, hint: 'কমপক্ষে ১০ অক্ষর। কয়েকটি শব্দের একটি বাক্য মনে রাখা সহজ।', attrs: { autocomplete: 'new-password', autofocus: 'autofocus' } })}
    ${field({ name: 'password_confirm', label: 'আবার লিখুন', type: 'password', errors, required: true, attrs: { autocomplete: 'new-password' } })}
    <button class="btn btn-primary btn-block" type="submit">${invite ? 'পাসওয়ার্ড সেট করুন' : 'পাসওয়ার্ড বদলান'}</button>
  </form>
</section>`,
  }), NO_REFERRER);
}

router.get('/reset-password', async (req, res) => {
  const row = await findValidToken(req.query.token, RESET_PURPOSES);
  if (!row || row.status !== 'active') return invalidLink(req, res, 'রিসেট');
  resetPage(req, res, 200, row);
});

router.post('/reset-password', async (req, res) => {
  const row = await findValidToken(req.body.token, RESET_PURPOSES);
  if (!row || row.status !== 'active') return invalidLink(req, res, 'রিসেট');

  const errors = {};
  const password = validatePassword(req.body.password, req.body.password_confirm, row.email, errors);
  if (Object.keys(errors).length) return resetPage(req, res, 422, row, { errors });

  // Consume first: if two requests race, only one may change the password.
  if (!(await consumeToken(row))) return invalidLink(req, res, 'রিসেট');
  await users.resetPassword(row.user_id, await hashPassword(password));
  await tokens.invalidate(row.user_id, RESET_PURPOSES);
  await sessions.removeForUser(row.user_id); // sign out everywhere, including an attacker's session

  const invite = row.purpose === 'invite';
  await logAudit({ ip: req.ip, user: { id: row.user_id } }, invite ? 'user.invite_accept' : 'user.password_reset', `user:${row.user_id}`);
  if (!invite) sendMailInBackground({ to: row.email, ...templates.passwordChanged({ name: row.name }) });
  res.redirect(303, `/login?m=${invite ? 'invite_accepted' : 'password_reset'}`);
});

// ---- Email verification -----------------------------------------------------------------------------

// GET only shows a button: mail scanners that pre-fetch links must not be able to act on the token.
router.get('/verify-email', async (req, res) => {
  const row = await findValidToken(req.query.token, ['verify_email']);
  if (!row) return invalidLink(req, res, 'যাচাই');
  const csrf = csrfToken(req, res);
  sendHtml(res, 200, authPage(req, {
    title: 'ইমেইল যাচাই',
    body: html`<section class="auth-card card center">
  <div class="big-icon" aria-hidden="true">✓</div>
  <h1>ইমেইল যাচাই করুন</h1>
  <p><strong>${row.email}</strong> ঠিকানাটি নিশ্চিত করতে নিচের বাটনে ক্লিক করুন।</p>
  <form method="post" action="/verify-email">
    ${csrfField(csrf)}<input type="hidden" name="token" value="${req.query.token}">
    <button class="btn btn-primary btn-block" type="submit">হ্যাঁ, এটি আমার ইমেইল</button>
  </form>
</section>`,
  }), NO_REFERRER);
});

router.post('/verify-email', async (req, res) => {
  const row = await findValidToken(req.body.token, ['verify_email']);
  if (!row || !(await consumeToken(row))) return invalidLink(req, res, 'যাচাই');
  await users.markVerified(row.user_id);
  await logAudit({ ip: req.ip, user: { id: row.user_id } }, 'user.verify_email', `user:${row.user_id}`);
  res.redirect(303, req.user ? '/account?m=email_verified' : '/login?m=email_verified');
});
