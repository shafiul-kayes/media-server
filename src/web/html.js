import { config } from '../config.js';
import { esc } from '../pages/html.js';

/**
 * Auto-escaping HTML templates: every interpolated value is escaped unless it is itself the
 * result of `html` (or explicitly wrapped with `raw`). Arrays are joined. This makes XSS the
 * opt-in case instead of the default.
 */
class SafeHtml {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

export const raw = (value) => new SafeHtml(String(value));

function render(value) {
  if (value == null || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// ---- Formatting helpers ---------------------------------------------------------------------------

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export const bn = (value) => String(value).replace(/\d/g, (d) => BN_DIGITS[d]);

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function formatDate(ms, withTime = true) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export const STATUS = {
  pending: { label: 'অপেক্ষমাণ', tone: 'warn' },
  approved: { label: 'অনুমোদিত', tone: 'ok' },
  rejected: { label: 'প্রত্যাখ্যাত', tone: 'bad' },
  revoked: { label: 'বাতিলকৃত', tone: 'muted' },
  active: { label: 'সক্রিয়', tone: 'ok' },
  suspended: { label: 'স্থগিত', tone: 'bad' },
};

export const badge = (status) => {
  const s = STATUS[status] ?? { label: status, tone: 'muted' };
  return html`<span class="badge badge-${s.tone}">${s.label}</span>`;
};

export function usageBar(used, quota) {
  const pct = quota ? Math.min(100, Math.round((Number(used) / Number(quota)) * 100)) : 0;
  const tone = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  return html`<div class="usage">
    <div class="usage-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
      aria-label="স্টোরেজ ব্যবহার"><span class="usage-fill usage-${tone} w-${Math.round(pct / 5) * 5}"></span></div>
    <div class="usage-text">${formatBytes(used)} / ${formatBytes(quota)} (${bn(pct)}%)</div>
  </div>`;
}

// ---- Forms --------------------------------------------------------------------------------------------

export const csrfField = (token) => html`<input type="hidden" name="_csrf" value="${token}">`;

export function field({ name, label, type = 'text', value = '', errors = {}, hint, required, attrs = {}, textarea, options }) {
  const id = `f-${name}`;
  const error = errors[name];
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || null;
  const extra = raw(Object.entries(attrs).map(([k, v]) => ` ${esc(k)}="${esc(v)}"`).join(''));
  let control;
  if (textarea) {
    control = html`<textarea id="${id}" name="${name}" ${required ? raw('required') : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''} ${error ? raw('aria-invalid="true"') : ''}${extra}>${value}</textarea>`;
  } else if (options) {
    control = html`<select id="${id}" name="${name}" ${required ? raw('required') : ''} ${error ? raw('aria-invalid="true"') : ''}${extra}>
      <option value="">— বাছাই করুন —</option>
      ${Object.entries(options).map(([v, l]) => html`<option value="${v}" ${v === value ? raw('selected') : ''}>${l}</option>`)}
    </select>`;
  } else {
    control = html`<input id="${id}" name="${name}" type="${type}" value="${type === 'password' ? '' : value}" ${required ? raw('required') : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''} ${error ? raw('aria-invalid="true"') : ''}${extra}>`;
  }
  return html`<div class="field ${error ? 'has-error' : ''}">
    <label for="${id}">${label}${required ? html` <span class="req" aria-hidden="true">*</span>` : ''}</label>
    ${control}
    ${hint ? html`<p class="hint" id="${id}-hint">${hint}</p>` : ''}
    ${error ? html`<p class="error" id="${id}-err">${error}</p>` : ''}
  </div>`;
}

export function scopeChecks(selected, errors = {}) {
  const items = [
    ['upload', 'আপলোড', 'ফাইল আপলোড ও visibility বদল'],
    ['read', 'পড়া', 'নিজের ফাইলের তালিকা, তথ্য ও signed URL'],
    ['delete', 'মোছা', 'API দিয়ে ফাইল মুছে ফেলা'],
  ];
  return html`<fieldset class="field ${errors.scopes ? 'has-error' : ''}">
    <legend>অনুমতি (scope)</legend>
    <div class="checks">
      ${items.map(([v, l, d]) => html`<label class="check">
        <input type="checkbox" name="scopes" value="${v}" ${selected.includes(v) ? raw('checked') : ''}>
        <span><strong>${l}</strong> <code>${v}</code><br><small>${d}</small></span>
      </label>`)}
    </div>
    ${errors.scopes ? html`<p class="error">${errors.scopes}</p>` : ''}
  </fieldset>`;
}

export function pagination(basePath, page, pages, params = {}) {
  if (pages <= 1) return '';
  const link = (p) => `${basePath}?${new URLSearchParams({ ...params, page: String(p) })}`;
  return html`<nav class="pager" aria-label="পৃষ্ঠা">
    ${page > 1 ? html`<a href="${link(page - 1)}">← আগের</a>` : html`<span></span>`}
    <span>${bn(page)} / ${bn(pages)}</span>
    ${page < pages ? html`<a href="${link(page + 1)}">পরের →</a>` : html`<span></span>`}
  </nav>`;
}

// ---- Flash messages (fixed codes only, so no attacker-controlled text is ever rendered) ------------

const FLASH = {
  registered: ['ok', 'অ্যাকাউন্ট তৈরি হয়েছে। স্বাগতম! এখন আপনার প্রথম API অনুরোধ করুন।'],
  requested: ['ok', 'অনুরোধ জমা হয়েছে। অ্যাডমিন অনুমোদন দিলে এখানে API key তৈরি করতে পারবেন।'],
  password_changed: ['ok', 'পাসওয়ার্ড বদলানো হয়েছে। অন্যান্য ডিভাইস থেকে লগআউট করা হয়েছে।'],
  profile_saved: ['ok', 'প্রোফাইল সংরক্ষিত হয়েছে।'],
  logged_out: ['ok', 'আপনি লগআউট হয়েছেন।'],
  approved: ['ok', 'অনুরোধ অনুমোদিত হয়েছে। ইউজার এখন API key তৈরি করতে পারবেন।'],
  rejected: ['ok', 'অনুরোধ প্রত্যাখ্যান করা হয়েছে।'],
  revoked: ['ok', 'API অ্যাক্সেস বাতিল করা হয়েছে। key আর কাজ করবে না।'],
  reactivated: ['ok', 'API অ্যাক্সেস পুনরায় চালু হয়েছে।'],
  limits_saved: ['ok', 'সীমা ও অনুমতি আপডেট হয়েছে।'],
  user_suspended: ['ok', 'ইউজার স্থগিত করা হয়েছে; তার সব সেশন ও API key বন্ধ।'],
  user_activated: ['ok', 'ইউজার সক্রিয় করা হয়েছে।'],
  role_changed: ['ok', 'ইউজারের ভূমিকা বদলানো হয়েছে।'],
  sessions_cleared: ['ok', 'অন্য সব ডিভাইস থেকে লগআউট করা হয়েছে।'],
  user_sessions_cleared: ['ok', 'ইউজারের সব সেশন বন্ধ করা হয়েছে।'],
  key_toggled: ['ok', 'API key এর অবস্থা বদলানো হয়েছে।'],
  file_deleted: ['ok', 'ফাইল মুছে ফেলা হয়েছে।'],
  not_pending: ['bad', 'এই অনুরোধটি ইতিমধ্যে অন্য কেউ রিভিউ করেছে।'],
  verify_sent: ['ok', 'যাচাইয়ের লিংকসহ একটি ইমেইল পাঠানো হয়েছে। ইনবক্স (আর স্প্যাম ফোল্ডার) দেখুন।'],
  verify_throttled: ['bad', 'কিছুক্ষণ আগেই ইমেইল পাঠানো হয়েছে। এক মিনিট পর আবার চেষ্টা করুন।'],
  email_verified: ['ok', 'ইমেইল যাচাই সম্পন্ন হয়েছে। ধন্যবাদ!'],
  already_verified: ['ok', 'আপনার ইমেইল আগেই যাচাই করা হয়েছে।'],
  password_reset: ['ok', 'নতুন পাসওয়ার্ড সেট হয়েছে। এখন লগইন করুন।'],
  invite_accepted: ['ok', 'পাসওয়ার্ড সেট হয়েছে, আপনার অ্যাকাউন্ট চালু। এখন লগইন করুন।'],
  verify_required: ['bad', 'এই কাজের আগে আপনার ইমেইল যাচাই করুন।'],
  invite_sent: ['ok', 'আমন্ত্রণ ইমেইল পাঠানো হয়েছে।'],
  invite_mail_failed: ['bad', 'অ্যাকাউন্ট তৈরি হয়েছে, কিন্তু ইমেইল পাঠানো যায়নি। SMTP সেটিং ঠিক করে এই পেজ থেকে "আমন্ত্রণ আবার পাঠান" চাপুন।'],
  reset_link_sent: ['ok', 'ইউজারকে পাসওয়ার্ড রিসেট লিংক পাঠানো হয়েছে।'],
  reset_link_throttled: ['bad', 'এই ইউজারকে গত এক ঘণ্টায় অনেকগুলো রিসেট লিংক পাঠানো হয়েছে।'],
  verification_sent: ['ok', 'ইউজারকে যাচাই ইমেইল পাঠানো হয়েছে।'],
  marked_verified: ['ok', 'ইমেইল যাচাইকৃত হিসেবে চিহ্নিত করা হয়েছে।'],
  cannot_self: ['bad', 'নিজের অ্যাকাউন্টে এই কাজ করা যাবে না।'],
};

export function flash(code) {
  const entry = FLASH[code];
  if (!entry) return '';
  const [tone, text] = entry;
  return html`<div class="alert alert-${tone}" role="status">${text}</div>`;
}

// ---- Page shells --------------------------------------------------------------------------------------

const baseOrigin = new URL(config.baseUrl).origin;

/** Panel CSP: same-origin CSS/JS only, no inline script; images also from the public file host. */
const PANEL_CSP = [
  "default-src 'none'",
  `img-src 'self' data: ${baseOrigin}`,
  "style-src 'self'",
  "script-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function sendHtml(res, status, page, headers = {}) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PANEL_CSP,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex',
    ...headers,
  });
  res.send(String(page));
}

function documentShell({ title, body, bodyClass = '' }) {
  return html`<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${config.appName}</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

const brand = html`<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">◧</span> ${config.appName}</a>`;

export function logoutForm(csrf) {
  return html`<form method="post" action="/logout" class="inline">${csrfField(csrf)}<button type="submit" class="btn btn-ghost btn-sm">লগআউট</button></form>`;
}

/** Marketing / auth pages. */
export function publicPage(req, { title, body }) {
  const nav = req.user
    ? html`<a href="/account" class="btn btn-primary btn-sm">ড্যাশবোর্ড</a>`
    : html`<a href="/login">লগইন</a><a href="/register" class="btn btn-primary btn-sm">রেজিস্ট্রেশন</a>`;
  return documentShell({
    title,
    bodyClass: 'public',
    body: html`<header class="topbar"><div class="topbar-inner">${brand}<nav class="topnav"><a href="/docs">API রেফারেন্স</a>${nav}</nav></div></header>
<main class="public-main">${body}</main>
<footer class="footer"><div class="topbar-inner"><span>© ${bn(new Date().getFullYear())} ${config.appName}</span><span><a href="/docs">API ডক</a> · <a href="/openapi.json">OpenAPI</a></span></div></footer>`,
  });
}

const USER_NAV = [
  ['/account', 'ড্যাশবোর্ড', 'overview'],
  ['/account/apps', 'আমার অ্যাপ ও API', 'apps'],
  ['/account/apps/new', 'নতুন API অনুরোধ', 'new'],
  ['/account/docs', 'ইন্টিগ্রেশন গাইড', 'docs'],
  ['/account/settings', 'অ্যাকাউন্ট সেটিংস', 'settings'],
];

const ADMIN_NAV = [
  ['/admin', 'ওভারভিউ', 'admin'],
  ['/admin/requests', 'API অনুরোধ', 'requests'],
  ['/admin/users', 'ইউজার', 'users'],
  ['/admin/keys', 'সব API key', 'keys'],
  ['/admin/audit', 'অডিট লগ', 'audit'],
];

/** Logged-in dashboard with sidebar navigation. */
export function appPage(req, { title, active, body, flashCode, pendingCount = 0 }) {
  const csrf = req.session.csrf_token;
  const navLink = ([href, label, key], badgeCount) => html`<a href="${href}" class="${active === key ? 'active' : ''}" ${active === key ? raw('aria-current="page"') : ''}>
      <span>${label}</span>${badgeCount ? html`<span class="count">${bn(badgeCount)}</span>` : ''}</a>`;
  return documentShell({
    title,
    bodyClass: 'app',
    body: html`<header class="topbar"><div class="topbar-inner">
  ${brand}
  <div class="topnav">
    <span class="whoami">${req.user.name}${req.user.role === 'admin' ? html` <span class="badge badge-info">অ্যাডমিন</span>` : ''}</span>
    ${logoutForm(csrf)}
  </div>
</div></header>
<div class="shell">
  <nav class="sidebar" aria-label="মেনু">
    <div class="nav-group"><div class="nav-title">আমার অ্যাকাউন্ট</div>${USER_NAV.map((l) => navLink(l))}<a href="/docs">API রেফারেন্স ↗</a></div>
    ${req.user.role === 'admin' ? html`<div class="nav-group"><div class="nav-title">অ্যাডমিন প্যানেল</div>${ADMIN_NAV.map((l) => navLink(l, l[2] === 'requests' ? pendingCount : 0))}</div>` : ''}
  </nav>
  <main class="content" id="main">
    ${flash(flashCode)}
    ${config.accounts.requireEmailVerification && !req.user.emailVerified ? html`<div class="alert alert-warn verify-banner" role="status">
      <span><strong>আপনার ইমেইল (${req.user.email}) এখনো যাচাই করা হয়নি।</strong> ইমেইলে পাঠানো লিংকে ক্লিক করুন। যাচাই না হওয়া পর্যন্ত API অনুরোধ করা যাবে না।</span>
      <form method="post" action="/account/verify/resend" class="inline">${csrfField(csrf)}<button type="submit" class="btn btn-ghost btn-sm">ইমেইল আবার পাঠান</button></form>
    </div>` : ''}
    ${body}
  </main>
</div>`,
  });
}

export function errorPage(req, status, message) {
  const title = status === 404 ? 'পাওয়া যায়নি' : status === 403 ? 'অনুমতি নেই' : status === 429 ? 'একটু অপেক্ষা করুন' : 'সমস্যা হয়েছে';
  return publicPage(req, {
    title,
    body: html`<section class="narrow card center"><div class="err-code">${bn(status)}</div><h1>${title}</h1><p class="muted">${message}</p>
      <p><a class="btn btn-primary" href="${req.user ? '/account' : '/'}">${req.user ? 'ড্যাশবোর্ডে ফিরুন' : 'হোমে ফিরুন'}</a></p></section>`,
  });
}
