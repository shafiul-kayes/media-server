import crypto from 'node:crypto';
import express from 'express';
import { apps, audit, dashboardStats, listKeys, sessions, users } from '../accounts/repo.js';
import { hashPassword } from '../accounts/password.js';
import { requireAdmin } from '../accounts/session.js';
import { sendInvitation, sendPasswordResetEmail, sendVerificationEmail } from '../accounts/tokens.js';
import { DEFAULT_QUOTA_MB, VOLUMES, normalizeEmail, validateName, validateReview } from '../accounts/validate.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { sendMailInBackground } from '../mail/mailer.js';
import * as templates from '../mail/templates.js';
import * as repo from '../repo.js';
import { hashKey } from '../services/apiKeys.js';
import { logAudit, toId, toPage } from './common.js';
import {
  appPage, badge, bn, csrfField, field, formatBytes, formatDate, html, pagination, scopeChecks, sendHtml, usageBar,
} from './html.js';

export const router = express.Router();

router.use(requireAdmin, async (req, res, next) => {
  res.locals.pendingCount = (await apps.statusCounts()).pending;
  next();
});

const page = (req, res, status, opts) => sendHtml(res, status, appPage(req, { ...opts, flashCode: req.query.m, pendingCount: res.locals.pendingCount }));
const PAGE_SIZE = 25;

async function findApp(req) {
  const app = await apps.findById(toId(req.params.id));
  if (!app) throw new HttpError(404, 'not_found', 'অনুরোধটি পাওয়া যায়নি');
  return app;
}

async function findUser(req) {
  const user = await users.findById(toId(req.params.id));
  if (!user) throw new HttpError(404, 'not_found', 'ইউজার পাওয়া যায়নি');
  return user;
}

const userLink = (id, text) => html`<a href="/admin/users/${id}">${text}</a>`;

function requestsTable(rows) {
  return html`<div class="table-wrap"><table class="table">
  <thead><tr><th>অ্যাপ</th><th>ইউজার</th><th>ব্যবহার</th><th>স্ট্যাটাস</th><th>তারিখ</th></tr></thead>
  <tbody>${rows.map((a) => html`<tr>
    <td><a href="/admin/requests/${a.id}">${a.name}</a></td>
    <td>${userLink(a.user_id, a.user_email)}</td>
    <td>${VOLUMES[a.expected_volume] ?? a.expected_volume}</td>
    <td>${badge(a.status)}</td>
    <td>${formatDate(a.created_at)}</td>
  </tr>`)}</tbody></table></div>`;
}

// ---- Overview -----------------------------------------------------------------------------------------

router.get('/', async (req, res) => {
  const [stats, counts, pending, recent] = await Promise.all([
    dashboardStats(),
    apps.statusCounts(),
    apps.list({ status: 'pending', limit: 5, offset: 0 }),
    audit.list({ limit: 8, offset: 0 }),
  ]);
  page(req, res, 200, {
    title: 'অ্যাডমিন ওভারভিউ',
    active: 'admin',
    body: html`<div class="page-head"><h1>অ্যাডমিন ওভারভিউ</h1></div>
<div class="stats">
  <a class="stat stat-link ${counts.pending ? 'stat-attn' : ''}" href="/admin/requests?status=pending"><span class="stat-label">অপেক্ষমাণ অনুরোধ</span><span class="stat-value">${bn(counts.pending)}</span></a>
  <div class="stat"><span class="stat-label">সক্রিয় অ্যাপ</span><span class="stat-value">${bn(counts.approved)}</span></div>
  <a class="stat stat-link" href="/admin/users"><span class="stat-label">ইউজার</span><span class="stat-value">${bn(stats.users)}</span><span class="stat-sub">এই সপ্তাহে +${bn(stats.newUsers)}</span></a>
  <div class="stat"><span class="stat-label">ফাইল · স্টোরেজ</span><span class="stat-value">${bn(stats.files)}</span><span class="stat-sub">${formatBytes(stats.bytes)}</span></div>
</div>
<div class="card"><div class="card-head"><h2>রিভিউয়ের অপেক্ষায়</h2><a href="/admin/requests?status=pending">সব দেখুন</a></div>
  ${pending.rows.length ? requestsTable(pending.rows) : html`<p class="muted">কোনো অপেক্ষমাণ অনুরোধ নেই। 🎉</p>`}</div>
<div class="card"><div class="card-head"><h2>সাম্প্রতিক কার্যক্রম</h2><a href="/admin/audit">অডিট লগ</a></div>${auditTable(recent.rows)}</div>`,
  });
});

// ---- Requests -----------------------------------------------------------------------------------------

const STATUS_TABS = [['pending', 'অপেক্ষমাণ'], ['approved', 'অনুমোদিত'], ['rejected', 'প্রত্যাখ্যাত'], ['revoked', 'বাতিলকৃত'], ['', 'সব']];

router.get('/requests', async (req, res) => {
  const status = STATUS_TABS.some(([s]) => s && s === req.query.status) ? req.query.status : req.query.status === '' ? '' : 'pending';
  const current = toPage(req.query.page);
  const { rows, total } = await apps.list({ status: status || null, limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE });
  page(req, res, 200, {
    title: 'API অনুরোধ',
    active: 'requests',
    body: html`<div class="page-head"><h1>API অনুরোধ</h1></div>
<nav class="filter-tabs" aria-label="স্ট্যাটাস">${STATUS_TABS.map(([s, l]) => html`<a href="/admin/requests?status=${s}" class="${s === status ? 'active' : ''}">${l}</a>`)}</nav>
<div class="card">${rows.length ? requestsTable(rows) : html`<p class="muted">এই তালিকায় কিছু নেই।</p>`}
${pagination('/admin/requests', current, Math.ceil(total / PAGE_SIZE), { status })}</div>`,
  });
});

function reviewPage(req, res, status, app, { values, errors = {} } = {}) {
  const csrf = req.session.csrf_token;
  const isApproved = app.status === 'approved';
  const defaults = values ?? {
    scopes: (isApproved ? app.key_scopes : app.requested_scopes).split(','),
    origins: (isApproved ? app.key_origins : app.requested_origins).split(',').filter(Boolean),
    quotaMb: isApproved ? Math.round(app.quota_bytes / 1048576) : DEFAULT_QUOTA_MB,
    note: '',
  };
  const limitsForm = (action, submitLabel, extra = '') => html`<form method="post" action="${action}" novalidate>
    ${csrfField(csrf)}
    ${scopeChecks(defaults.scopes, errors)}
    ${field({ name: 'quota_mb', label: 'স্টোরেজ quota (MB)', type: 'number', value: String(defaults.quotaMb), errors, required: true, attrs: { min: 1 } })}
    ${field({ name: 'origins', label: 'অনুমোদিত ব্রাউজার ডোমেইন', value: defaults.origins.join('\n'), errors, textarea: true, hint: 'প্রতি লাইনে একটি। খালি রাখলে key শুধু সার্ভার থেকে কাজ করবে।', attrs: { rows: 3 } })}
    ${extra}
    <button class="btn btn-primary" type="submit">${submitLabel}</button>
  </form>`;

  page(req, res, status, {
    title: `অনুরোধ: ${app.name}`,
    active: 'requests',
    body: html`<div class="page-head"><div><p class="crumbs"><a href="/admin/requests">API অনুরোধ</a> /</p><h1>${app.name} ${badge(app.status)}</h1></div></div>
<div class="grid-2">
  <div class="card"><h2>অনুরোধের তথ্য</h2>
    <dl class="kv">
      <dt>ইউজার</dt><dd>${userLink(app.user_id, app.user_name)} <span class="muted">${app.user_email}</span> ${app.user_status !== 'active' ? badge(app.user_status) : ''}</dd>
      <dt>ওয়েবসাইট</dt><dd>${app.website ? html`<a href="${app.website}" rel="noopener noreferrer nofollow" target="_blank">${app.website}</a>` : '—'}</dd>
      <dt>উদ্দেশ্য</dt><dd class="prewrap">${app.purpose}</dd>
      <dt>আনুমানিক ব্যবহার</dt><dd>${VOLUMES[app.expected_volume] ?? app.expected_volume}</dd>
      <dt>চাওয়া অনুমতি</dt><dd>${app.requested_scopes.split(',').map((s) => html`<code>${s}</code> `)}</dd>
      <dt>চাওয়া ডোমেইন</dt><dd>${app.requested_origins ? app.requested_origins.split(',').map((o) => html`<code>${o}</code> `) : '—'}</dd>
      <dt>অনুরোধের তারিখ</dt><dd>${formatDate(app.created_at)}</dd>
      ${app.reviewed_at ? html`<dt>রিভিউ</dt><dd>${formatDate(app.reviewed_at)} · ${app.reviewer_name ?? '—'}</dd>` : ''}
      ${app.admin_note ? html`<dt>মন্তব্য</dt><dd class="prewrap">${app.admin_note}</dd>` : ''}
    </dl>
  </div>
  ${isApproved || app.status === 'revoked' ? html`<div class="card"><h2>API key</h2>
    ${usageBar(app.used_bytes, app.quota_bytes)}
    <dl class="kv">
      <dt>key</dt><dd>${app.key_issued_at ? html`<code>${app.key_prefix}…</code> (${formatDate(app.key_issued_at, false)})` : html`<span class="muted">ইউজার এখনো তৈরি করেননি</span>`}</dd>
      <dt>শেষ ব্যবহার</dt><dd>${formatDate(app.last_used_at)}</dd>
      <dt>অবস্থা</dt><dd>${app.key_active ? badge('active') : badge('revoked')}</dd>
    </dl></div>` : ''}
</div>

${app.status === 'pending' ? html`<div class="grid-2">
  <div class="card"><h2>অনুমোদন</h2><p class="muted">প্রয়োজনে অনুমতি, quota আর ডোমেইন বদলে দিন। ইউজার এগুলো বদলাতে পারবেন না।</p>
    ${limitsForm(`/admin/requests/${app.id}/approve`, '✓ অনুমোদন দিন', field({ name: 'note', label: 'ইউজারের জন্য মন্তব্য (ঐচ্ছিক)', value: defaults.note ?? '', errors, textarea: true, attrs: { rows: 2, maxlength: 1000 } }))}</div>
  <div class="card"><h2>প্রত্যাখ্যান</h2>
    <form method="post" action="/admin/requests/${app.id}/reject" data-confirm="অনুরোধটি প্রত্যাখ্যান করবেন?">
      ${csrfField(csrf)}
      ${field({ name: 'note', label: 'কারণ (ইউজার দেখতে পাবেন)', errors, textarea: true, required: true, attrs: { rows: 3, maxlength: 1000 } })}
      <button class="btn btn-danger" type="submit">✕ প্রত্যাখ্যান করুন</button>
    </form></div>
</div>` : ''}

${isApproved ? html`<div class="grid-2">
  <div class="card"><h2>সীমা ও অনুমতি</h2>${limitsForm(`/admin/requests/${app.id}/limits`, 'আপডেট করুন')}</div>
  <div class="card"><h2>অ্যাক্সেস বাতিল</h2><p>বাতিল করলে key সাথে সাথে কাজ করা বন্ধ করবে। আপলোড করা ফাইল থেকে যাবে, আর পরে আবার চালু করা যাবে।</p>
    <form method="post" action="/admin/requests/${app.id}/revoke" data-confirm="এই অ্যাপের API অ্যাক্সেস বাতিল করবেন?">
      ${csrfField(csrf)}${field({ name: 'note', label: 'কারণ (ইউজার দেখতে পাবেন)', errors: {}, textarea: true, attrs: { rows: 2, maxlength: 1000 } })}
      <button class="btn btn-danger" type="submit">অ্যাক্সেস বাতিল করুন</button></form></div>
</div>` : ''}

${app.status === 'revoked' ? html`<div class="card"><h2>পুনরায় চালু</h2>
  <form method="post" action="/admin/requests/${app.id}/reactivate">${csrfField(csrf)}<button class="btn btn-primary" type="submit">অ্যাক্সেস আবার চালু করুন</button></form></div>` : ''}`,
  });
}

router.get('/requests/:id', async (req, res) => reviewPage(req, res, 200, await findApp(req)));

router.post('/requests/:id/approve', async (req, res) => {
  const app = await findApp(req);
  if (app.status !== 'pending') return res.redirect(303, `/admin/requests/${app.id}?m=not_pending`);
  const { values, errors } = validateReview(req.body);
  if (Object.keys(errors).length) return reviewPage(req, res, 422, app, { values, errors });

  const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;
  try {
    await apps.approve({
      id: app.id,
      reviewerId: req.user.id,
      note: values.note,
      key: {
        id: keyId,
        userId: app.user_id,
        name: app.name,
        // Placeholder secret nobody knows; the key only works once the owner generates a real one.
        keyHash: hashKey(crypto.randomBytes(32).toString('base64url')),
        prefix: '', // set when the owner generates the key
        scopes: values.scopes.join(','),
        quotaBytes: values.quotaMb * 1048576,
        allowedOrigins: values.origins.join(','),
      },
    });
  } catch (err) {
    if (err.conflict) return res.redirect(303, `/admin/requests/${app.id}?m=not_pending`);
    throw err;
  }
  sendMailInBackground({ to: app.user_email, ...templates.appApproved({ name: app.user_name, appName: app.name, appId: app.id, note: values.note }) });
  await logAudit(req, 'app.approve', `app:${app.id}`, `scopes=${values.scopes.join(',')} quota=${values.quotaMb}MB origins=${values.origins.join(',') || '-'}`);
  res.redirect(303, `/admin/requests/${app.id}?m=approved`);
});

router.post('/requests/:id/reject', async (req, res) => {
  const app = await findApp(req);
  const note = String(req.body.note ?? '').trim().slice(0, 1000);
  if (!note) return reviewPage(req, res, 422, app, { errors: { note: 'প্রত্যাখ্যানের কারণ লিখুন' } });
  const ok = await apps.setStatus({ id: app.id, from: 'pending', to: 'rejected', reviewerId: req.user.id, note });
  if (!ok) return res.redirect(303, `/admin/requests/${app.id}?m=not_pending`);
  sendMailInBackground({ to: app.user_email, ...templates.appRejected({ name: app.user_name, appName: app.name, appId: app.id, note }) });
  await logAudit(req, 'app.reject', `app:${app.id}`, note);
  res.redirect(303, `/admin/requests/${app.id}?m=rejected`);
});

router.post('/requests/:id/limits', async (req, res) => {
  const app = await findApp(req);
  if (app.status !== 'approved' || !app.api_key_id) throw new HttpError(409, 'conflict', 'শুধু অনুমোদিত অ্যাপের সীমা বদলানো যায়');
  const { values, errors } = validateReview(req.body);
  if (Object.keys(errors).length) return reviewPage(req, res, 422, app, { values, errors });
  await repo.keys.update(app.api_key_id, {
    scopes: values.scopes.join(','),
    quota_bytes: values.quotaMb * 1048576,
    allowed_origins: values.origins.join(','),
  });
  await logAudit(req, 'app.limits', `app:${app.id}`, `scopes=${values.scopes.join(',')} quota=${values.quotaMb}MB origins=${values.origins.join(',') || '-'}`);
  res.redirect(303, `/admin/requests/${app.id}?m=limits_saved`);
});

router.post('/requests/:id/revoke', async (req, res) => {
  const app = await findApp(req);
  const note = String(req.body.note ?? '').trim().slice(0, 1000) || null;
  if (!(await apps.setStatus({ id: app.id, from: 'approved', to: 'revoked', reviewerId: req.user.id, note }))) {
    return res.redirect(303, `/admin/requests/${app.id}?m=not_pending`);
  }
  if (app.api_key_id) await repo.keys.update(app.api_key_id, { active: 0 });
  sendMailInBackground({ to: app.user_email, ...templates.appRevoked({ name: app.user_name, appName: app.name, appId: app.id, note }) });
  await logAudit(req, 'app.revoke', `app:${app.id}`, note);
  res.redirect(303, `/admin/requests/${app.id}?m=revoked`);
});

router.post('/requests/:id/reactivate', async (req, res) => {
  const app = await findApp(req);
  if (!(await apps.setStatus({ id: app.id, from: 'revoked', to: 'approved', reviewerId: req.user.id, note: null }))) {
    return res.redirect(303, `/admin/requests/${app.id}?m=not_pending`);
  }
  if (app.api_key_id) await repo.keys.update(app.api_key_id, { active: 1 });
  await logAudit(req, 'app.reactivate', `app:${app.id}`);
  res.redirect(303, `/admin/requests/${app.id}?m=reactivated`);
});

// ---- Users ----------------------------------------------------------------------------------------------

router.get('/users', async (req, res) => {
  const search = String(req.query.q ?? '').trim().slice(0, 100);
  const current = toPage(req.query.page);
  const { rows, total } = await users.list({ search, limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE });
  page(req, res, 200, {
    title: 'ইউজার',
    active: 'users',
    body: html`<div class="page-head"><h1>ইউজার <span class="muted">(${bn(total)})</span></h1>
  <div class="head-actions">
    <form method="get" action="/admin/users" class="search" role="search"><label for="q" class="sr-only">খুঁজুন</label>
      <input id="q" name="q" type="search" value="${search}" placeholder="নাম বা ইমেইল দিয়ে খুঁজুন"><button class="btn btn-ghost" type="submit">খুঁজুন</button></form>
    <a class="btn btn-primary" href="/admin/users/new">+ আমন্ত্রণ</a>
  </div></div>
<div class="card"><div class="table-wrap"><table class="table">
  <thead><tr><th>নাম</th><th>ইমেইল</th><th>ভূমিকা</th><th>অবস্থা</th><th>অ্যাপ</th><th>যোগদান</th><th>শেষ লগইন</th></tr></thead>
  <tbody>${rows.map((u) => html`<tr>
    <td>${userLink(u.id, u.name)}</td><td>${u.email} ${u.email_verified_at ? html`<span class="verified" title="ইমেইল যাচাইকৃত">✓</span>` : html`<span class="badge badge-warn">যাচাই হয়নি</span>`}</td>
    <td>${u.role === 'admin' ? html`<span class="badge badge-info">অ্যাডমিন</span>` : 'ইউজার'}</td>
    <td>${badge(u.status)}</td><td>${bn(u.app_count)}</td>
    <td>${formatDate(u.created_at, false)}</td><td>${formatDate(u.last_login_at)}</td>
  </tr>`)}</tbody></table></div>
  ${pagination('/admin/users', current, Math.ceil(total / PAGE_SIZE), { q: search })}</div>`,
  });
});

// ---- Invitations (create a user or admin who sets their own password by email) ----------------------------

function inviteForm(req, res, status, { values = {}, errors = {} } = {}) {
  page(req, res, status, {
    title: 'আমন্ত্রণ পাঠান',
    active: 'users',
    body: html`<div class="page-head"><div><p class="crumbs"><a href="/admin/users">ইউজার</a> /</p><h1>নতুন ইউজার বা অ্যাডমিন আমন্ত্রণ</h1>
  <p class="muted">আমন্ত্রিত ব্যক্তি ইমেইলের লিংক থেকে নিজের পাসওয়ার্ড সেট করবেন, আর তাতেই তার ইমেইল যাচাই হয়ে যাবে। লিংকটি ${bn(config.accounts.inviteTokenDays)} দিন কাজ করবে।</p></div></div>
<form method="post" action="/admin/users/new" class="card form-card" novalidate>
  ${csrfField(req.session.csrf_token)}
  ${field({ name: 'name', label: 'নাম', value: values.name, errors, required: true, attrs: { maxlength: 100 } })}
  ${field({ name: 'email', label: 'ইমেইল', type: 'email', value: values.email, errors, required: true, attrs: { maxlength: 254 } })}
  ${field({ name: 'role', label: 'ভূমিকা', value: values.role ?? 'user', errors, required: true, options: { user: 'ইউজার (API অনুরোধ করতে পারবেন)', admin: 'অ্যাডমিন (সব কিছু নিয়ন্ত্রণ করতে পারবেন)' } })}
  <div class="form-actions"><button class="btn btn-primary" type="submit">আমন্ত্রণ পাঠান</button><a class="btn btn-ghost" href="/admin/users">বাতিল</a></div>
</form>`,
  });
}

router.get('/users/new', (req, res) => inviteForm(req, res, 200));

router.post('/users/new', async (req, res) => {
  const errors = {};
  const name = validateName(req.body.name, errors);
  const email = normalizeEmail(req.body.email);
  if (!/^[^\s@<>]{1,64}@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254) errors.email = 'সঠিক ইমেইল দিন';
  const role = req.body.role === 'admin' ? 'admin' : req.body.role === 'user' ? 'user' : null;
  if (!role) errors.role = 'ভূমিকা বাছাই করুন';
  if (!errors.email && (await users.findByEmail(email))) errors.email = 'এই ইমেইলে আগেই অ্যাকাউন্ট আছে';
  if (Object.keys(errors).length) return inviteForm(req, res, 422, { values: { name, email, role: req.body.role }, errors });

  // Random, never-revealed password: the account is unusable until the invitee sets their own.
  const id = await users.create({ name, email, role, passwordHash: await hashPassword(crypto.randomBytes(32).toString('base64url')) });
  const { sent } = await sendInvitation({ id, name, email }, { role, invitedBy: req.user.name, ip: req.ip });
  await logAudit(req, 'user.invite', `user:${id}`, `role=${role}`);
  res.redirect(303, `/admin/users/${id}?m=${sent ? 'invite_sent' : 'invite_mail_failed'}`);
});

router.post('/users/:id/invite', async (req, res) => {
  const user = await findUser(req);
  const { sent } = await sendInvitation(user, { role: user.role, invitedBy: req.user.name, ip: req.ip });
  await logAudit(req, 'user.invite', `user:${user.id}`, 'resend');
  res.redirect(303, `/admin/users/${user.id}?m=${sent ? 'invite_sent' : 'invite_mail_failed'}`);
});

router.post('/users/:id/send-reset', async (req, res) => {
  const user = await findUser(req);
  const sent = user.status === 'active' && (await sendPasswordResetEmail(user, req.ip));
  if (sent) await logAudit(req, 'user.send_reset', `user:${user.id}`);
  res.redirect(303, `/admin/users/${user.id}?m=${sent ? 'reset_link_sent' : 'reset_link_throttled'}`);
});

router.post('/users/:id/send-verification', async (req, res) => {
  const user = await findUser(req);
  if (user.email_verified_at) return res.redirect(303, `/admin/users/${user.id}`);
  const sent = await sendVerificationEmail(user, req.ip);
  res.redirect(303, `/admin/users/${user.id}?m=${sent ? 'verification_sent' : 'verify_throttled'}`);
});

router.post('/users/:id/verify', async (req, res) => {
  const user = await findUser(req);
  await users.markVerified(user.id);
  await logAudit(req, 'user.mark_verified', `user:${user.id}`);
  res.redirect(303, `/admin/users/${user.id}?m=marked_verified`);
});

router.get('/users/:id', async (req, res) => {
  const user = await findUser(req);
  const [userApps, sessionCount, log] = await Promise.all([
    apps.listForUser(user.id),
    sessions.countForUser(user.id),
    audit.list({ limit: 10, offset: 0, actorId: user.id }),
  ]);
  const csrf = req.session.csrf_token;
  const self = user.id === req.user.id;
  page(req, res, 200, {
    title: user.name,
    active: 'users',
    body: html`<div class="page-head"><div><p class="crumbs"><a href="/admin/users">ইউজার</a> /</p><h1>${user.name} ${badge(user.status)} ${user.role === 'admin' ? html`<span class="badge badge-info">অ্যাডমিন</span>` : ''}</h1></div></div>
<div class="grid-2">
  <div class="card"><h2>তথ্য</h2><dl class="kv">
    <dt>ইমেইল</dt><dd>${user.email}</dd>
    <dt>ইমেইল যাচাই</dt><dd>${user.email_verified_at ? html`✓ ${formatDate(user.email_verified_at)}` : html`<span class="badge badge-warn">যাচাই হয়নি</span>`}</dd>
    <dt>যোগদান</dt><dd>${formatDate(user.created_at)}</dd>
    <dt>শেষ লগইন</dt><dd>${formatDate(user.last_login_at)}</dd>
    <dt>সক্রিয় সেশন</dt><dd>${bn(sessionCount)}</dd>
    ${user.locked_until && user.locked_until > Date.now() ? html`<dt>লক</dt><dd>${formatDate(user.locked_until)} পর্যন্ত</dd>` : ''}
  </dl></div>
  <div class="card"><h2>পদক্ষেপ</h2>
    ${self ? html`<p class="muted">নিজের অ্যাকাউন্ট স্থগিত বা ভূমিকা পরিবর্তন করা যায় না।</p>` : html`
    <div class="actions">
      ${user.status === 'active'
        ? html`<form method="post" action="/admin/users/${user.id}/status" data-confirm="ইউজারকে স্থগিত করবেন? তার সব API key ও সেশন সাথে সাথে বন্ধ হবে।">${csrfField(csrf)}<input type="hidden" name="status" value="suspended"><button class="btn btn-danger" type="submit">স্থগিত করুন</button></form>`
        : html`<form method="post" action="/admin/users/${user.id}/status">${csrfField(csrf)}<input type="hidden" name="status" value="active"><button class="btn btn-primary" type="submit">সক্রিয় করুন</button></form>`}
      <form method="post" action="/admin/users/${user.id}/role" data-confirm="${user.role === 'admin' ? 'অ্যাডমিন অধিকার সরিয়ে নেবেন?' : 'এই ইউজারকে অ্যাডমিন বানাবেন? তিনি সব ইউজার ও অনুরোধ নিয়ন্ত্রণ করতে পারবেন।'}">
        ${csrfField(csrf)}<input type="hidden" name="role" value="${user.role === 'admin' ? 'user' : 'admin'}">
        <button class="btn btn-ghost" type="submit">${user.role === 'admin' ? 'অ্যাডমিন অধিকার সরান' : 'অ্যাডমিন বানান'}</button></form>
      <form method="post" action="/admin/users/${user.id}/sessions">${csrfField(csrf)}<button class="btn btn-ghost" type="submit">সব সেশন বন্ধ করুন</button></form>
    </div>`}
    <h3 class="mt">অ্যাকাউন্ট পুনরুদ্ধার</h3>
    <div class="actions">
      ${!user.last_login_at && !user.email_verified_at
        ? html`<form method="post" action="/admin/users/${user.id}/invite">${csrfField(csrf)}<button class="btn btn-ghost" type="submit">✉ আমন্ত্রণ আবার পাঠান</button></form>`
        : html`<form method="post" action="/admin/users/${user.id}/send-reset" data-confirm="${user.email} ঠিকানায় পাসওয়ার্ড রিসেট লিংক পাঠাবেন?">${csrfField(csrf)}<button class="btn btn-ghost" type="submit">✉ পাসওয়ার্ড রিসেট লিংক পাঠান</button></form>`}
      ${user.email_verified_at ? '' : html`
        <form method="post" action="/admin/users/${user.id}/send-verification">${csrfField(csrf)}<button class="btn btn-ghost" type="submit">✉ যাচাই ইমেইল পাঠান</button></form>
        <form method="post" action="/admin/users/${user.id}/verify" data-confirm="ইমেইল না দেখেই যাচাইকৃত হিসেবে চিহ্নিত করবেন? শুধু নিশ্চিত হলে করুন।">${csrfField(csrf)}<button class="btn btn-ghost" type="submit">যাচাইকৃত হিসেবে চিহ্নিত করুন</button></form>`}
    </div>
    <p class="muted small">নিরাপত্তার জন্য অ্যাডমিন কারো পাসওয়ার্ড দেখতে বা নিজে সেট করতে পারেন না; রিসেট লিংক শুধু ইউজারের ইমেইলে যায়।</p>
  </div>
</div>
<div class="card"><h2>অ্যাপ</h2>${userApps.length ? requestsTable(userApps) : html`<p class="muted">কোনো অ্যাপ নেই।</p>`}</div>
<div class="card"><h2>সাম্প্রতিক কার্যক্রম</h2>${auditTable(log.rows)}</div>`,
  });
});

router.post('/users/:id/status', async (req, res) => {
  const user = await findUser(req);
  if (user.id === req.user.id) return res.redirect(303, `/admin/users/${user.id}?m=cannot_self`);
  const status = req.body.status === 'suspended' ? 'suspended' : 'active';
  await users.setStatus(user.id, status);
  if (status === 'suspended') await sessions.removeForUser(user.id);
  await logAudit(req, status === 'suspended' ? 'user.suspend' : 'user.activate', `user:${user.id}`);
  res.redirect(303, `/admin/users/${user.id}?m=${status === 'suspended' ? 'user_suspended' : 'user_activated'}`);
});

router.post('/users/:id/role', async (req, res) => {
  const user = await findUser(req);
  if (user.id === req.user.id) return res.redirect(303, `/admin/users/${user.id}?m=cannot_self`);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  await users.setRole(user.id, role);
  await sessions.removeForUser(user.id); // re-login picks up the new role everywhere
  await logAudit(req, 'user.role', `user:${user.id}`, role);
  res.redirect(303, `/admin/users/${user.id}?m=role_changed`);
});

router.post('/users/:id/sessions', async (req, res) => {
  const user = await findUser(req);
  await sessions.removeForUser(user.id, user.id === req.user.id ? req.session.id : '');
  await logAudit(req, 'user.sessions_revoke', `user:${user.id}`);
  res.redirect(303, `/admin/users/${user.id}?m=user_sessions_cleared`);
});

// ---- Keys --------------------------------------------------------------------------------------------------

router.get('/keys', async (req, res) => {
  const current = toPage(req.query.page);
  const { rows, total } = await listKeys({ limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE });
  const csrf = req.session.csrf_token;
  page(req, res, 200, {
    title: 'সব API key',
    active: 'keys',
    body: html`<div class="page-head"><div><h1>সব API key <span class="muted">(${bn(total)})</span></h1>
  <p class="muted">ইউজার অ্যাপের key আর <code>npm run create-key</code> দিয়ে বানানো সার্ভার key একসাথে।</p></div></div>
<div class="card"><div class="table-wrap"><table class="table">
  <thead><tr><th>নাম</th><th>মালিক</th><th>key</th><th>অনুমতি</th><th>স্টোরেজ</th><th>শেষ ব্যবহার</th><th>অবস্থা</th></tr></thead>
  <tbody>${rows.map((k) => html`<tr>
    <td>${k.app_id ? html`<a href="/admin/requests/${k.app_id}">${k.name}</a>` : k.name}</td>
    <td>${k.owner_id ? userLink(k.owner_id, k.owner_email) : html`<span class="muted">সার্ভার (CLI)</span>`}</td>
    <td>${k.key_issued_at ? html`<code>${k.prefix}…</code>` : html`<span class="muted">তৈরি হয়নি</span>`}</td>
    <td>${k.scopes.split(',').map((s) => html`<code>${s}</code> `)}</td>
    <td>${formatBytes(k.used_bytes)} / ${formatBytes(k.quota_bytes)}</td>
    <td>${formatDate(k.last_used_at)}</td>
    <td>${k.app_id ? (k.active ? badge('active') : badge('revoked')) : html`<form method="post" action="/admin/keys/${k.id}/toggle">${csrfField(csrf)}
      <button class="btn btn-sm ${k.active ? 'btn-danger-ghost' : 'btn-ghost'}" type="submit">${k.active ? 'বন্ধ করুন' : 'চালু করুন'}</button></form>`}</td>
  </tr>`)}</tbody></table></div>
  ${pagination('/admin/keys', current, Math.ceil(total / PAGE_SIZE))}</div>`,
  });
});

router.post('/keys/:id/toggle', async (req, res) => {
  const key = typeof req.params.id === 'string' && /^key_[0-9a-f]{16}$/.test(req.params.id) ? await repo.keys.findById(req.params.id) : undefined;
  if (!key) throw new HttpError(404, 'not_found', 'key পাওয়া যায়নি');
  await repo.keys.update(key.id, { active: key.active ? 0 : 1 });
  await logAudit(req, key.active ? 'key.disable' : 'key.enable', key.id);
  res.redirect(303, '/admin/keys?m=key_toggled');
});

// ---- Audit log ------------------------------------------------------------------------------------------

const ACTIONS = {
  'user.register': 'রেজিস্ট্রেশন', 'user.login': 'লগইন', 'user.login_failed': 'ব্যর্থ লগইন', 'user.logout': 'লগআউট',
  'user.password_change': 'পাসওয়ার্ড পরিবর্তন', 'user.sessions_revoke': 'সেশন বন্ধ', 'user.suspend': 'ইউজার স্থগিত',
  'user.activate': 'ইউজার সক্রিয়', 'user.role': 'ভূমিকা পরিবর্তন', 'app.request': 'API অনুরোধ', 'app.approve': 'অনুমোদন',
  'app.reject': 'প্রত্যাখ্যান', 'app.revoke': 'অ্যাক্সেস বাতিল', 'app.reactivate': 'অ্যাক্সেস পুনরায় চালু', 'app.limits': 'সীমা পরিবর্তন',
  'key.generate': 'key তৈরি', 'user.verify_email': 'ইমেইল যাচাই', 'user.password_reset_request': 'রিসেট লিংক চাওয়া',
  'user.password_reset': 'পাসওয়ার্ড রিসেট', 'user.invite': 'আমন্ত্রণ', 'user.invite_accept': 'আমন্ত্রণ গ্রহণ', 'user.send_reset': 'রিসেট লিংক পাঠানো',
  'user.mark_verified': 'ম্যানুয়ালি যাচাই', 'key.rotate': 'key rotate', 'key.disable': 'key বন্ধ', 'key.enable': 'key চালু', 'file.delete': 'ফাইল মোছা',
};

function auditTable(rows) {
  if (!rows.length) return html`<p class="muted">কোনো কার্যক্রম নেই।</p>`;
  return html`<div class="table-wrap"><table class="table table-compact">
  <thead><tr><th>সময়</th><th>কে</th><th>কাজ</th><th>লক্ষ্য</th><th>বিস্তারিত</th><th>IP</th></tr></thead>
  <tbody>${rows.map((r) => html`<tr>
    <td>${formatDate(r.created_at)}</td>
    <td>${r.actor_id ? userLink(r.actor_id, r.actor_email ?? `#${r.actor_id}`) : html`<span class="muted">—</span>`}</td>
    <td>${ACTIONS[r.action] ?? r.action}</td>
    <td>${r.target && /^app:\d+$/.test(r.target) ? html`<a href="/admin/requests/${r.target.slice(4)}">${r.target}</a>` : (r.target ?? '')}</td>
    <td class="clip">${r.details ?? ''}</td>
    <td><code>${r.ip ?? ''}</code></td>
  </tr>`)}</tbody></table></div>`;
}

router.get('/audit', async (req, res) => {
  const current = toPage(req.query.page);
  const { rows, total } = await audit.list({ limit: 50, offset: (current - 1) * 50 });
  page(req, res, 200, {
    title: 'অডিট লগ',
    active: 'audit',
    body: html`<div class="page-head"><h1>অডিট লগ</h1></div><div class="card">${auditTable(rows)}${pagination('/admin/audit', current, Math.ceil(total / 50))}</div>`,
  });
});

