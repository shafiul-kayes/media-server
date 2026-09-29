import express from 'express';
import { hashPassword, verifyPassword } from '../accounts/password.js';
import { apps, sessions, users } from '../accounts/repo.js';
import { isVerified, requireUser } from '../accounts/session.js';
import { sendVerificationEmail } from '../accounts/tokens.js';
import { VOLUMES, validateAppRequest, validateName, validatePassword } from '../accounts/validate.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import * as repo from '../repo.js';
import { issueSecret } from '../services/apiKeys.js';
import { sendMailInBackground } from '../mail/mailer.js';
import * as templates from '../mail/templates.js';
import { fileDTO } from '../services/serialize.js';
import { isValidId, removeStoredBytes } from '../services/storage.js';
import { logAudit, toId, toPage } from './common.js';
import { codeBlock, integrationGuide } from './guide.js';
import {
  appPage, badge, bn, csrfField, field, formatBytes, formatDate, html, pagination, raw, scopeChecks, sendHtml, usageBar,
} from './html.js';

export const router = express.Router();
router.use(requireUser);

const page = (req, res, status, opts) => sendHtml(res, status, appPage(req, { ...opts, flashCode: req.query.m, pendingCount: res.locals.pendingCount }));

async function ownApp(req) {
  const app = await apps.findForUser(toId(req.params.id), req.user.id);
  if (!app) throw new HttpError(404, 'not_found', 'অ্যাপটি পাওয়া যায়নি');
  return app;
}

const appLink = (app) => html`<a href="/account/apps/${app.id}">${app.name}</a>`;

// ---- Email verification -----------------------------------------------------------------------------

router.post('/verify/resend', async (req, res) => {
  if (req.user.emailVerified) return res.redirect(303, '/account?m=already_verified');
  const user = await users.findById(req.user.id);
  const sent = await sendVerificationEmail(user, req.ip);
  res.redirect(303, `/account?m=${sent ? 'verify_sent' : 'verify_throttled'}`);
});

/** Blocks actions that need a verified email (the banner explains how to verify). */
function requireVerified(req, res, next) {
  if (isVerified(req.user)) return next();
  res.redirect(303, '/account?m=verify_required');
}

// ---- Overview ---------------------------------------------------------------------------------------

router.get('/', async (req, res) => {
  const list = await apps.listForUser(req.user.id);
  const approved = list.filter((a) => a.status === 'approved');
  const totals = { files: 0, bytes: 0 };
  for (const a of approved) {
    if (!a.api_key_id) continue;
    const s = await repo.keys.fileStats(a.api_key_id);
    totals.files += s.files;
    totals.bytes += s.bytes;
  }
  const hasKey = approved.some((a) => a.key_issued_at);
  const onboarding = [
    ['অ্যাকাউন্ট তৈরি', true, null],
    ['ইমেইল যাচাই', isVerified(req.user), null],
    ['API অনুরোধ জমা', list.length > 0, '/account/apps/new'],
    ['অ্যাডমিনের অনুমোদন', approved.length > 0, null],
    ['API key তৈরি', hasKey, approved[0] ? `/account/apps/${approved[0].id}` : null],
    ['প্রথম ফাইল আপলোড', totals.files > 0, '/account/docs'],
  ];
  const done = onboarding.filter((s) => s[1]).length;

  page(req, res, 200, {
    title: 'ড্যাশবোর্ড',
    active: 'overview',
    body: html`
<div class="page-head"><div><h1>স্বাগতম, ${req.user.name}</h1><p class="muted">আপনার API অ্যাপ, ব্যবহার আর ইন্টিগ্রেশন এক জায়গায়।</p></div>
  <a class="btn btn-primary" href="/account/apps/new">+ নতুন API অনুরোধ</a></div>

<div class="stats">
  <div class="stat"><span class="stat-label">মোট অ্যাপ</span><span class="stat-value">${bn(list.length)}</span></div>
  <div class="stat"><span class="stat-label">অনুমোদিত</span><span class="stat-value">${bn(approved.length)}</span></div>
  <div class="stat"><span class="stat-label">মোট ফাইল</span><span class="stat-value">${bn(totals.files)}</span></div>
  <div class="stat"><span class="stat-label">স্টোরেজ</span><span class="stat-value">${formatBytes(totals.bytes)}</span></div>
</div>

${done < onboarding.length ? html`<div class="card">
  <h2>শুরু করার ধাপ <span class="muted">(${bn(done)}/${bn(onboarding.length)})</span></h2>
  <ol class="onboarding">
    ${onboarding.map(([label, ok, href]) => html`<li class="${ok ? 'done' : ''}"><span class="dot" aria-hidden="true">${ok ? '✓' : ''}</span>
      ${!ok && href ? html`<a href="${href}">${label}</a>` : label}${ok ? html`<span class="sr-only"> (সম্পন্ন)</span>` : ''}</li>`)}
  </ol>
</div>` : ''}

<div class="card">
  <div class="card-head"><h2>আমার অ্যাপ</h2><a href="/account/apps">সব দেখুন</a></div>
  ${list.length ? appsTable(list.slice(0, 5)) : html`<div class="empty"><p>এখনো কোনো API অনুরোধ করেননি।</p><a class="btn btn-primary" href="/account/apps/new">প্রথম অনুরোধ করুন</a></div>`}
</div>`,
  });
});

function appsTable(list) {
  return html`<div class="table-wrap"><table class="table">
  <thead><tr><th>অ্যাপ</th><th>স্ট্যাটাস</th><th>API key</th><th>অনুরোধের তারিখ</th></tr></thead>
  <tbody>${list.map((a) => html`<tr>
    <td>${appLink(a)}</td>
    <td>${badge(a.status)}</td>
    <td>${a.status === 'approved' ? (a.key_issued_at ? html`<code>${a.key_prefix}…</code>` : html`<span class="muted">এখনো তৈরি হয়নি</span>`) : '—'}</td>
    <td>${formatDate(a.created_at, false)}</td>
  </tr>`)}</tbody>
</table></div>`;
}

// ---- Applications -----------------------------------------------------------------------------------

router.get('/apps', async (req, res) => {
  const list = await apps.listForUser(req.user.id);
  page(req, res, 200, {
    title: 'আমার অ্যাপ ও API',
    active: 'apps',
    body: html`<div class="page-head"><h1>আমার অ্যাপ ও API</h1><a class="btn btn-primary" href="/account/apps/new">+ নতুন অনুরোধ</a></div>
<div class="card">${list.length ? appsTable(list) : html`<div class="empty"><p>কোনো অ্যাপ নেই।</p></div>`}</div>`,
  });
});

function requestForm(req, res, status, { values = {}, errors = {} } = {}) {
  page(req, res, status, {
    title: 'নতুন API অনুরোধ',
    active: 'new',
    body: html`<div class="page-head"><div><h1>নতুন API অনুরোধ</h1>
  <p class="muted">আপনার অ্যাপ সম্পর্কে জানান। অ্যাডমিন রিভিউ করে অনুমোদন দিলে এখান থেকেই API key তৈরি করতে পারবেন।</p></div></div>
<form method="post" action="/account/apps/new" class="card form-card" novalidate>
  ${csrfField(req.session.csrf_token)}
  ${errors.form ? html`<div class="alert alert-bad" role="alert">${errors.form}</div>` : ''}
  ${field({ name: 'name', label: 'অ্যাপ / প্রজেক্টের নাম', value: values.name, errors, required: true, attrs: { maxlength: 100 } })}
  ${field({ name: 'website', label: 'ওয়েবসাইট', type: 'url', value: values.website ?? '', errors, hint: 'যেখানে API ব্যবহার হবে (ঐচ্ছিক)', attrs: { placeholder: 'https://example.com', maxlength: 255 } })}
  ${field({ name: 'purpose', label: 'কী কাজে ব্যবহার করবেন?', value: values.purpose, errors, required: true, textarea: true, hint: 'যেমন: "আমাদের ই-কমার্স সাইটে বিক্রেতারা প্রোডাক্টের ছবি আপলোড করবেন। মাসে প্রায় ৫০০টি ছবি।"', attrs: { rows: 4, maxlength: 2000 } })}
  ${field({ name: 'expected_volume', label: 'আনুমানিক আপলোড', value: values.expectedVolume, errors, required: true, options: VOLUMES })}
  ${scopeChecks(values.scopes ?? ['upload', 'read'], errors)}
  ${field({ name: 'origins', label: 'ব্রাউজার থেকে ব্যবহারের ডোমেইন', value: (values.origins ?? []).join('\n'), errors, textarea: true, hint: 'শুধু ব্রাউজার JavaScript থেকে সরাসরি API কল করলে লাগবে। প্রতি লাইনে একটি, যেমন https://shop.example.com বা https://*.example.com। শুধু সার্ভার থেকে ব্যবহার করলে খালি রাখুন।', attrs: { rows: 3 } })}
  <div class="form-actions"><button class="btn btn-primary" type="submit">অনুরোধ জমা দিন</button><a class="btn btn-ghost" href="/account/apps">বাতিল</a></div>
</form>`,
  });
}

router.get('/apps/new', requireVerified, (req, res) => requestForm(req, res, 200));

router.post('/apps/new', requireVerified, async (req, res) => {
  const { values, errors } = validateAppRequest(req.body);
  const counts = await apps.countForUser(req.user.id);
  if (counts.total >= config.accounts.maxAppsPerUser) errors.form = `সর্বোচ্চ ${bn(config.accounts.maxAppsPerUser)}টি অ্যাপ করা যায়।`;
  else if (counts.pending >= config.accounts.maxPendingPerUser) errors.form = 'আপনার কয়েকটি অনুরোধ এখনো রিভিউয়ের অপেক্ষায়। সেগুলোর সিদ্ধান্তের পর নতুন অনুরোধ করুন।';
  if (Object.keys(errors).length) return requestForm(req, res, 422, { values, errors });

  const id = await apps.create({
    userId: req.user.id,
    name: values.name,
    website: values.website,
    purpose: values.purpose,
    expectedVolume: values.expectedVolume,
    requestedScopes: values.scopes.join(','),
    requestedOrigins: values.origins.join(','),
  });
  await logAudit(req, 'app.request', `app:${id}`, values.name);
  if (config.accounts.notifyAdminsOnRequest) {
    for (const admin of await users.listVerifiedAdmins()) {
      sendMailInBackground({
        to: admin.email,
        ...templates.newRequestForAdmins({ adminName: admin.name, userName: req.user.name, userEmail: req.user.email, appName: values.name, appId: id }),
      });
    }
  }
  res.redirect(303, `/account/apps/${id}?m=requested`);
});

function keySection(app, csrf) {
  if (!app.key_issued_at) {
    return html`<div class="key-empty">
  <p>আপনার অনুরোধ অনুমোদিত হয়েছে। এখন API key তৈরি করুন। key শুধু একবারই দেখানো হবে।</p>
  <form method="post" action="/account/apps/${app.id}/key">${csrfField(csrf)}<button class="btn btn-primary" type="submit">API key তৈরি করুন</button></form>
</div>`;
  }
  return html`<dl class="kv">
  <dt>API key</dt><dd><code>${app.key_prefix}…</code> <span class="muted">(পুরো key শুধু তৈরির সময় দেখানো হয়)</span></dd>
  <dt>তৈরি</dt><dd>${formatDate(app.key_issued_at)}</dd>
  <dt>শেষ ব্যবহার</dt><dd>${formatDate(app.last_used_at)}</dd>
</dl>
<form method="post" action="/account/apps/${app.id}/key" data-confirm="নতুন key তৈরি করলে বর্তমান key সাথে সাথে বন্ধ হয়ে যাবে। আপনার অ্যাপে নতুন key বসাতে হবে। চালিয়ে যাবেন?">
  ${csrfField(csrf)}<button class="btn btn-ghost" type="submit">↻ key rotate করুন</button>
</form>`;
}

router.get('/apps/:id', async (req, res) => {
  const app = await ownApp(req);
  const stats = app.api_key_id ? await repo.keys.fileStats(app.api_key_id) : { files: 0, bytes: 0 };
  const origins = (app.status === 'approved' ? app.key_origins : app.requested_origins)?.split(',').filter(Boolean) ?? [];
  const scopes = (app.status === 'approved' ? app.key_scopes : app.requested_scopes).split(',');

  const statusBox = {
    pending: html`<div class="alert alert-warn">আপনার অনুরোধ রিভিউয়ের অপেক্ষায় আছে। অনুমোদন হলে এই পেজেই API key তৈরির অপশন আসবে।</div>`,
    rejected: html`<div class="alert alert-bad"><strong>অনুরোধটি প্রত্যাখ্যাত হয়েছে।</strong>${app.admin_note ? html`<br>অ্যাডমিনের মন্তব্য: ${app.admin_note}` : ''}<br><a href="/account/apps/new">তথ্য সংশোধন করে নতুন অনুরোধ করুন →</a></div>`,
    revoked: html`<div class="alert alert-bad"><strong>এই অ্যাপের API অ্যাক্সেস বাতিল করা হয়েছে।</strong> key আর কাজ করবে না।${app.admin_note ? html`<br>অ্যাডমিনের মন্তব্য: ${app.admin_note}` : ''}</div>`,
    approved: app.admin_note ? html`<div class="alert alert-ok">অ্যাডমিনের মন্তব্য: ${app.admin_note}</div>` : '',
  }[app.status];

  page(req, res, 200, {
    title: app.name,
    active: 'apps',
    body: html`<div class="page-head"><div><p class="crumbs"><a href="/account/apps">আমার অ্যাপ</a> /</p><h1>${app.name} ${badge(app.status)}</h1></div></div>
${statusBox}
${app.status === 'approved' ? html`
<div class="grid-2">
  <div class="card"><h2>API key</h2>${keySection(app, req.session.csrf_token)}</div>
  <div class="card"><h2>ব্যবহার ও সীমা</h2>
    ${usageBar(app.used_bytes, app.quota_bytes)}
    <dl class="kv">
      <dt>ফাইল</dt><dd>${bn(stats.files)}টি · <a href="/account/apps/${app.id}/files">ফাইল ম্যানেজার →</a></dd>
      <dt>অনুমতি</dt><dd>${scopes.map((s) => html`<code>${s}</code> `)}</dd>
      <dt>ব্রাউজার ডোমেইন</dt><dd>${origins.length ? origins.map((o) => html`<code>${o}</code> `) : html`<span class="muted">নেই (শুধু সার্ভার থেকে)</span>`}</dd>
    </dl>
  </div>
</div>
${app.key_issued_at ? html`<div class="card"><div class="card-head"><h2>দ্রুত শুরু</h2><a href="/account/docs?app=${app.id}">এই অ্যাপের পূর্ণ গাইড →</a></div>
  ${codeBlock(`curl -X POST "${config.baseUrl}/api/v1/upload" \\\n  -H "X-API-Key: ${app.key_prefix}…আপনার_পুরো_key" \\\n  -F "image=@photo.jpg"`, 'bash')}</div>` : ''}` : ''}

<div class="card"><h2>অনুরোধের তথ্য</h2>
  <dl class="kv">
    <dt>ওয়েবসাইট</dt><dd>${app.website ? html`<a href="${app.website}" rel="noopener noreferrer nofollow" target="_blank">${app.website}</a>` : '—'}</dd>
    <dt>উদ্দেশ্য</dt><dd class="prewrap">${app.purpose}</dd>
    <dt>আনুমানিক ব্যবহার</dt><dd>${VOLUMES[app.expected_volume] ?? app.expected_volume}</dd>
    <dt>অনুরোধকৃত অনুমতি</dt><dd>${app.requested_scopes.split(',').map((s) => html`<code>${s}</code> `)}</dd>
    <dt>অনুরোধের তারিখ</dt><dd>${formatDate(app.created_at)}</dd>
    ${app.reviewed_at ? html`<dt>রিভিউ</dt><dd>${formatDate(app.reviewed_at)}</dd>` : ''}
  </dl>
</div>`,
  });
});

router.post('/apps/:id/key', requireVerified, async (req, res) => {
  const app = await ownApp(req);
  if (app.status !== 'approved' || !app.api_key_id) throw new HttpError(409, 'conflict', 'শুধু অনুমোদিত অ্যাপের key তৈরি করা যায়');
  const rotated = Boolean(app.key_issued_at);
  const secret = await issueSecret(app.api_key_id);
  await logAudit(req, rotated ? 'key.rotate' : 'key.generate', `app:${app.id}`, app.api_key_id);

  page(req, res, 200, {
    title: 'আপনার API key',
    active: 'apps',
    body: html`<div class="page-head"><h1>${rotated ? 'নতুন API key' : 'আপনার API key'}</h1></div>
<div class="card key-reveal">
  <div class="alert alert-warn"><strong>এখনই key টি কপি করে নিরাপদ জায়গায় রাখুন।</strong> এই পেজ ছাড়ার পর এটা আর দেখা যাবে না; আমরা শুধু এর hash সংরক্ষণ করি।${rotated ? ' পুরনো key টি এখন থেকে আর কাজ করবে না।' : ''}</div>
  ${codeBlock(secret, 'API key')}
  <h3>পরের ধাপ</h3>
  <ol>
    <li>সার্ভারের <code>.env</code> ফাইলে রাখুন: <code>MEDIA_API_KEY=${secret.slice(0, 7)}…</code></li>
    <li><a href="/account/docs?app=${app.id}">ইন্টিগ্রেশন গাইড</a> থেকে আপনার ভাষার কোড কপি করুন।</li>
  </ol>
  <p><a class="btn btn-primary" href="/account/apps/${app.id}">key সংরক্ষণ করেছি, ফিরে যান</a></p>
</div>`,
  });
});

// ---- File manager -----------------------------------------------------------------------------------

router.get('/apps/:id/files', async (req, res) => {
  const app = await ownApp(req);
  if (!app.api_key_id) throw new HttpError(404, 'not_found', 'এই অ্যাপের কোনো ফাইল নেই');
  const current = toPage(req.query.page);
  const limit = 24;
  const filter = { keyId: app.api_key_id };
  const total = await repo.files.count(filter);
  const list = await repo.files.list({ ...filter, limit, offset: (current - 1) * limit });
  const csrf = req.session.csrf_token;

  page(req, res, 200, {
    title: `${app.name}: ফাইল`,
    active: 'apps',
    body: html`<div class="page-head"><div><p class="crumbs"><a href="/account/apps">আমার অ্যাপ</a> / <a href="/account/apps/${app.id}">${app.name}</a> /</p>
  <h1>ফাইল ম্যানেজার</h1><p class="muted">মোট ${bn(total)}টি ফাইল · ${formatBytes(app.used_bytes)} ব্যবহৃত</p></div></div>
${list.length ? html`<div class="file-grid">
  ${list.map((f) => {
    const dto = fileDTO(f, { signedForSeconds: 900 });
    return html`<article class="file-card">
      <a class="file-thumb" href="${dto.url}" target="_blank" rel="noopener">${f.kind === 'image'
        ? html`<img src="${dto.thumb_url}" alt="" loading="lazy">`
        : html`<span class="pdf-icon" aria-hidden="true">PDF</span>`}</a>
      <div class="file-meta">
        <strong title="${f.original_name}">${f.original_name}</strong>
        <span class="muted">${formatBytes(f.size)} · ${f.visibility === 'private' ? 'প্রাইভেট' : 'পাবলিক'}</span>
        <span class="muted">${formatDate(f.created_at, false)}</span>
      </div>
      <div class="file-actions">
        <button type="button" class="btn btn-ghost btn-sm copy" data-copy-text="${dto.url}">লিংক কপি</button>
        <form method="post" action="/account/apps/${app.id}/files/${f.id}/delete" data-confirm="ফাইলটি স্থায়ীভাবে মুছে ফেলবেন?">
          ${csrfField(csrf)}<button type="submit" class="btn btn-danger-ghost btn-sm">মুছুন</button></form>
      </div>
    </article>`;
  })}
</div>${pagination(`/account/apps/${app.id}/files`, current, Math.ceil(total / limit))}` : html`<div class="card empty"><p>এখনো কোনো ফাইল আপলোড হয়নি।</p><a href="/account/docs?app=${app.id}">আপলোড করার কোড দেখুন →</a></div>`}`,
  });
});

router.post('/apps/:id/files/:fileId/delete', async (req, res) => {
  const app = await ownApp(req);
  const file = isValidId(req.params.fileId) ? await repo.files.findById(req.params.fileId) : undefined;
  if (!file || !app.api_key_id || file.key_id !== app.api_key_id) throw new HttpError(404, 'not_found', 'ফাইলটি পাওয়া যায়নি');
  if (await repo.files.removeWithQuota(file)) await removeStoredBytes(file);
  await logAudit(req, 'file.delete', `file:${file.id}`, `app:${app.id}`);
  res.redirect(303, `/account/apps/${app.id}/files?m=file_deleted`);
});

// ---- Integration guide ------------------------------------------------------------------------------

router.get('/docs', async (req, res) => {
  const list = (await apps.listForUser(req.user.id)).filter((a) => a.status === 'approved');
  const selected = list.find((a) => a.id === toId(req.query.app)) ?? list[0];
  page(req, res, 200, {
    title: 'ইন্টিগ্রেশন গাইড',
    active: 'docs',
    body: html`<div class="page-head"><div><h1>ইন্টিগ্রেশন গাইড</h1>
  <p class="muted">আপনার ওয়েবসাইট বা অ্যাপে আমাদের ইমেজ ও PDF সার্ভার যুক্ত করার সম্পূর্ণ নির্দেশিকা।${selected ? html` কোডগুলো <strong>${selected.name}</strong> অ্যাপের জন্য সাজানো।` : ''}</p></div>
  ${list.length > 1 ? html`<form method="get" action="/account/docs" class="inline-form"><label for="app-pick">অ্যাপ:</label>
    <select id="app-pick" name="app" data-autosubmit>${list.map((a) => html`<option value="${a.id}" ${a.id === selected?.id ? raw('selected') : ''}>${a.name}</option>`)}</select>
    <noscript><button class="btn btn-ghost btn-sm">দেখুন</button></noscript></form>` : ''}
</div>
${!list.length ? html`<div class="alert alert-warn">এখনো কোনো অনুমোদিত অ্যাপ নেই, তাই কোডে <code>YOUR_API_KEY</code> দেখাচ্ছে। <a href="/account/apps/new">API অনুরোধ করুন →</a></div>` : ''}
${integrationGuide({ app: selected })}`,
  });
});

// ---- Settings -----------------------------------------------------------------------------------------

async function settingsPage(req, res, status, { profileErrors = {}, passwordErrors = {}, name } = {}) {
  const user = await users.findById(req.user.id);
  const activeSessions = await sessions.countForUser(req.user.id);
  const csrf = req.session.csrf_token;
  page(req, res, status, {
    title: 'অ্যাকাউন্ট সেটিংস',
    active: 'settings',
    body: html`<div class="page-head"><h1>অ্যাকাউন্ট সেটিংস</h1></div>
<div class="grid-2">
  <form method="post" action="/account/settings/profile" class="card">
    <h2>প্রোফাইল</h2>
    ${csrfField(csrf)}
    ${field({ name: 'name', label: 'নাম', value: name ?? user.name, errors: profileErrors, required: true, attrs: { maxlength: 100, autocomplete: 'name' } })}
    <div class="field"><label for="f-email">ইমেইল</label><input id="f-email" type="email" value="${user.email}" disabled>
      <p class="hint">${user.email_verified_at ? html`✓ যাচাইকৃত (${formatDate(user.email_verified_at, false)})` : 'যাচাই করা হয়নি'}</p></div>
    <p class="muted">সদস্য: ${formatDate(user.created_at, false)} · শেষ লগইন: ${formatDate(user.last_login_at)}</p>
    <button class="btn btn-primary" type="submit">সংরক্ষণ</button>
  </form>
  <form method="post" action="/account/settings/password" class="card">
    <h2>পাসওয়ার্ড পরিবর্তন</h2>
    ${csrfField(csrf)}
    ${field({ name: 'current_password', label: 'বর্তমান পাসওয়ার্ড', type: 'password', errors: passwordErrors, required: true, attrs: { autocomplete: 'current-password' } })}
    ${field({ name: 'password', label: 'নতুন পাসওয়ার্ড', type: 'password', errors: passwordErrors, required: true, hint: 'কমপক্ষে ১০ অক্ষর', attrs: { autocomplete: 'new-password' } })}
    ${field({ name: 'password_confirm', label: 'নতুন পাসওয়ার্ড আবার', type: 'password', errors: passwordErrors, required: true, attrs: { autocomplete: 'new-password' } })}
    <button class="btn btn-primary" type="submit">পাসওয়ার্ড বদলান</button>
  </form>
</div>
<div class="card"><h2>সক্রিয় সেশন</h2>
  <p>আপনার অ্যাকাউন্টে এখন ${bn(activeSessions)}টি ডিভাইস/ব্রাউজার লগইন করা আছে।</p>
  <form method="post" action="/account/settings/sessions" data-confirm="এই ডিভাইস ছাড়া বাকি সব জায়গা থেকে লগআউট করবেন?">
    ${csrfField(csrf)}<button class="btn btn-ghost" type="submit">অন্য সব ডিভাইস থেকে লগআউট</button></form>
</div>`,
  });
}

router.get('/settings', (req, res) => settingsPage(req, res, 200));

router.post('/settings/profile', async (req, res) => {
  const errors = {};
  const name = validateName(req.body.name, errors);
  if (Object.keys(errors).length) return settingsPage(req, res, 422, { profileErrors: errors, name });
  await users.setName(req.user.id, name);
  res.redirect(303, '/account/settings?m=profile_saved');
});

router.post('/settings/password', async (req, res) => {
  const user = await users.findById(req.user.id);
  const errors = {};
  const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
  if (!(await verifyPassword(user.password_hash, current))) errors.current_password = 'বর্তমান পাসওয়ার্ড সঠিক নয়';
  const next = validatePassword(req.body.password, req.body.password_confirm, user.email, errors);
  if (!errors.password && next === current) errors.password = 'নতুন পাসওয়ার্ড আগেরটির চেয়ে আলাদা হতে হবে';
  if (Object.keys(errors).length) return settingsPage(req, res, 422, { passwordErrors: errors });

  await users.setPassword(user.id, await hashPassword(next));
  await sessions.removeForUser(user.id, req.session.id);
  await logAudit(req, 'user.password_change', `user:${user.id}`);
  sendMailInBackground({ to: user.email, ...templates.passwordChanged({ name: user.name }) });
  res.redirect(303, '/account/settings?m=password_changed');
});

router.post('/settings/sessions', async (req, res) => {
  await sessions.removeForUser(req.user.id, req.session.id);
  await logAudit(req, 'user.sessions_revoke', `user:${req.user.id}`);
  res.redirect(303, '/account/settings?m=sessions_cleared');
});
