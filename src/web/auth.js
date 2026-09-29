import express from 'express';
import { getDummyHash, hashPassword, verifyPassword } from '../accounts/password.js';
import { users } from '../accounts/repo.js';
import { csrfToken, endSession, requireUser, safeNext, startSession } from '../accounts/session.js';
import { sendVerificationEmail } from '../accounts/tokens.js';
import { normalizeEmail, validateRegistration } from '../accounts/validate.js';
import { config } from '../config.js';
import { loginLimiter, logAudit, registerLimiter } from './common.js';
import { bn, csrfField, field, flash, html, publicPage, sendHtml } from './html.js';

export const router = express.Router();

// ---- Landing page ---------------------------------------------------------------------------------

const FEATURES = [
  ['⇪', 'তিনভাবে আপলোড', 'ফাইল, base64 অথবা যেকোনো পাবলিক URL থেকে ইমেজ ও PDF আপলোড।'],
  ['⇄', 'imgbb-compatible', 'imgbb এর কোড আছে? শুধু বেস URL বদলান, আর কিছু লাগবে না।'],
  ['⤢', 'অন-দ্য-ফ্লাই রিসাইজ', 'লিংকে ?w=600&format=webp লিখলেই থাম্বনেইল ও WebP/AVIF তৈরি।'],
  ['⛨', 'নিরাপত্তা আগে', 'প্রতিটি ফাইল যাচাই ও পরিষ্কার করা হয়; ক্ষতিকর PDF আর ছদ্মবেশী ফাইল বাতিল।'],
  ['◎', 'ডোমেইন নিয়ন্ত্রণ', 'কোন ওয়েবসাইট থেকে আপনার key ব্যবহার হবে, আপনিই ঠিক করুন।'],
  ['⏱', 'প্রাইভেট ও মেয়াদি', 'প্রাইভেট ফাইলের জন্য মেয়াদি signed লিংক, আর নির্দিষ্ট সময় পর অটো-ডিলিট।'],
];

const STEPS = [
  ['রেজিস্ট্রেশন', 'ফ্রি অ্যাকাউন্ট খুলুন।'],
  ['API অনুরোধ', 'আপনার অ্যাপ ও ব্যবহারের উদ্দেশ্য জানান।'],
  ['অনুমোদন', 'অ্যাডমিন রিভিউ করে অনুমোদন দেবেন।'],
  ['key তৈরি', 'ড্যাশবোর্ড থেকে নিজের API key বানান।'],
  ['ইন্টিগ্রেশন', 'গাইডের কোড কপি করে কাজ শুরু।'],
];

router.get('/', (req, res) => {
  const sample = `curl -H "X-API-Key: ms_আপনার_key" \\
     -F "image=@photo.jpg" \\
     ${config.baseUrl}/api/v1/upload`;
  sendHtml(res, 200, publicPage(req, {
    title: 'ইমেজ ও PDF হোস্টিং API',
    body: html`
<section class="hero">
  <div class="hero-text">
    <p class="eyebrow">ডেভেলপারদের জন্য মিডিয়া হোস্টিং</p>
    <h1>আপনার অ্যাপের ইমেজ ও PDF রাখুন নিরাপদে, এক API তে</h1>
    <p class="lead">আপলোড করুন, রিসাইজ করুন, যেকোনো ওয়েবসাইটে embed করুন। অনুমোদিত প্রতিটি অ্যাপ পায় নিজের API key, নিজস্ব সীমা আর ধাপে ধাপে ইন্টিগ্রেশন গাইড।</p>
    <div class="hero-cta">
      ${req.user
        ? html`<a class="btn btn-primary btn-lg" href="/account">ড্যাশবোর্ডে যান</a>`
        : html`<a class="btn btn-primary btn-lg" href="/register">ফ্রি অ্যাকাউন্ট খুলুন</a><a class="btn btn-ghost btn-lg" href="/login">লগইন</a>`}
      <a class="btn btn-link" href="/docs">API রেফারেন্স →</a>
    </div>
  </div>
  <div class="hero-code" aria-label="উদাহরণ"><pre><code>${sample}</code></pre></div>
</section>

<section class="section">
  <h2 class="section-title">যা যা পাবেন</h2>
  <div class="grid-3">
    ${FEATURES.map(([icon, title, text]) => html`<article class="feature"><span class="feature-icon" aria-hidden="true">${icon}</span><h3>${title}</h3><p>${text}</p></article>`)}
  </div>
</section>

<section class="section">
  <h2 class="section-title">কীভাবে শুরু করবেন</h2>
  <ol class="steps">
    ${STEPS.map(([title, text], i) => html`<li><span class="step-no">${bn(i + 1)}</span><strong>${title}</strong><span>${text}</span></li>`)}
  </ol>
</section>`,
  }));
});

// ---- Registration ---------------------------------------------------------------------------------

function registerPage(req, res, status, { values = {}, errors = {}, closed = false } = {}) {
  const token = csrfToken(req, res);
  sendHtml(res, status, publicPage(req, {
    title: 'রেজিস্ট্রেশন',
    body: html`<section class="auth-card card">
  <h1>অ্যাকাউন্ট খুলুন</h1>
  <p class="muted">অ্যাকাউন্ট খোলার পর API ব্যবহারের অনুরোধ করতে পারবেন।</p>
  ${closed ? html`<div class="alert alert-bad">নতুন রেজিস্ট্রেশন এখন বন্ধ আছে।</div>` : html`
  ${errors.form ? html`<div class="alert alert-bad" role="alert">${errors.form}</div>` : ''}
  <form method="post" action="/register" novalidate>
    ${csrfField(token)}
    ${field({ name: 'name', label: 'আপনার নাম', value: values.name, errors, required: true, attrs: { autocomplete: 'name', maxlength: 100 } })}
    ${field({ name: 'email', label: 'ইমেইল', type: 'email', value: values.email, errors, required: true, attrs: { autocomplete: 'email', maxlength: 254 } })}
    ${field({ name: 'password', label: 'পাসওয়ার্ড', type: 'password', errors, required: true, hint: 'কমপক্ষে ১০ অক্ষর। একটি বাক্য বা কয়েকটি শব্দ মনে রাখা সহজ, ভাঙা কঠিন।', attrs: { autocomplete: 'new-password', minlength: 10, maxlength: 128 } })}
    ${field({ name: 'password_confirm', label: 'পাসওয়ার্ড আবার লিখুন', type: 'password', errors, required: true, attrs: { autocomplete: 'new-password' } })}
    <div class="hp" aria-hidden="true"><label for="f-website">ওয়েবসাইট</label><input id="f-website" name="website" tabindex="-1" autocomplete="off"></div>
    <div class="field ${errors.terms ? 'has-error' : ''}">
      <label class="check"><input type="checkbox" name="terms" value="yes" ${values.terms ? html`checked` : ''}>
        <span>আমি সম্মত যে কোনো অবৈধ, ক্ষতিকর বা অন্যের অধিকার লঙ্ঘনকারী ফাইল আপলোড করব না।</span></label>
      ${errors.terms ? html`<p class="error">${errors.terms}</p>` : ''}
    </div>
    <button class="btn btn-primary btn-block" type="submit">অ্যাকাউন্ট খুলুন</button>
  </form>`}
  <p class="center muted">আগেই অ্যাকাউন্ট আছে? <a href="/login">লগইন করুন</a></p>
</section>`,
  }));
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(303, '/account');
  registerPage(req, res, 200, { closed: !config.accounts.registrationEnabled });
});

router.post('/register', registerLimiter, async (req, res) => {
  if (!config.accounts.registrationEnabled) return registerPage(req, res, 403, { closed: true });
  // Honeypot: real users never see or fill this field.
  if (req.body.website) return res.redirect(303, '/login');

  const { values, errors } = validateRegistration(req.body);
  if (Object.keys(errors).length) return registerPage(req, res, 422, { values: { ...values, terms: req.body.terms }, errors });

  let userId;
  try {
    userId = await users.create({ name: values.name, email: values.email, passwordHash: await hashPassword(values.password) });
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    return registerPage(req, res, 422, { values, errors: { email: 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট খোলা হয়েছে। লগইন করুন।' } });
  }

  await users.recordLogin(userId); // registration counts as the first sign-in
  const user = await users.findById(userId);
  await startSession(req, res, user);
  req.user = user;
  await logAudit(req, 'user.register', `user:${userId}`);
  if (config.accounts.requireEmailVerification) {
    await sendVerificationEmail(user, req.ip);
    return res.redirect(303, '/account?m=verify_sent');
  }
  await users.markVerified(userId);
  res.redirect(303, '/account?m=registered');
});

// ---- Login / logout -------------------------------------------------------------------------------

function loginPage(req, res, status, { email = '', error = '', notice = '' } = {}) {
  const token = csrfToken(req, res);
  const next = safeNext(req.query.next ?? req.body?.next, '');
  sendHtml(res, status, publicPage(req, {
    title: 'লগইন',
    body: html`<section class="auth-card card">
  <h1>লগইন</h1>
  ${notice ? flash(notice) : ''}
  ${error ? html`<div class="alert alert-bad" role="alert">${error}</div>` : ''}
  <form method="post" action="/login">
    ${csrfField(token)}
    ${next ? html`<input type="hidden" name="next" value="${next}">` : ''}
    ${field({ name: 'email', label: 'ইমেইল', type: 'email', value: email, required: true, attrs: { autocomplete: 'username', autofocus: 'autofocus' } })}
    ${field({ name: 'password', label: 'পাসওয়ার্ড', type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}
    <p class="forgot"><a href="/forgot-password">পাসওয়ার্ড ভুলে গেছেন?</a></p>
    <button class="btn btn-primary btn-block" type="submit">লগইন</button>
  </form>
  <p class="center muted">অ্যাকাউন্ট নেই? <a href="/register">রেজিস্ট্রেশন করুন</a></p>
</section>`,
  }));
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(303, safeNext(req.query.next, '/account'));
  const notices = ['logged_out', 'email_verified', 'password_reset', 'invite_accepted'];
  loginPage(req, res, 200, { notice: notices.includes(req.query.m) ? req.query.m : '' });
});

const INVALID = 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।';

router.post('/login', loginLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email).slice(0, 254);
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 256) : '';
  const user = email ? await users.findByEmail(email) : undefined;

  // Always run one scrypt verification so response time does not reveal whether the email exists.
  const passwordOk = await verifyPassword(user?.password_hash ?? (await getDummyHash()), password);

  if (user && user.locked_until && user.locked_until > Date.now()) {
    return loginPage(req, res, 401, { email, error: `অনেকবার ভুল চেষ্টার কারণে অ্যাকাউন্টটি সাময়িকভাবে লক। ${bn(config.accounts.lockMinutes)} মিনিট পর আবার চেষ্টা করুন।` });
  }
  if (!user || !passwordOk) {
    if (user) {
      await users.recordFailedLogin(user.id, config.accounts.maxLoginFailures, config.accounts.lockMinutes);
      await logAudit({ ip: req.ip }, 'user.login_failed', `user:${user.id}`);
    }
    return loginPage(req, res, 401, { email, error: INVALID });
  }
  if (user.status !== 'active') {
    return loginPage(req, res, 401, { email, error: 'আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে। অ্যাডমিনের সাথে যোগাযোগ করুন।' });
  }

  await users.recordLogin(user.id);
  await startSession(req, res, user);
  req.user = user;
  await logAudit(req, 'user.login', `user:${user.id}`);
  res.redirect(303, safeNext(req.body.next, user.role === 'admin' ? '/admin' : '/account'));
});

router.post('/logout', requireUser, async (req, res) => {
  await logAudit(req, 'user.logout', `user:${req.user.id}`);
  await endSession(req, res);
  res.redirect(303, '/login?m=logged_out');
});
