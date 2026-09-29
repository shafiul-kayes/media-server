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
<link rel="stylesheet" href="/assets/motion.css">
<script src="/assets/app.js" defer></script>
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

// ---- Icons (inline SVG with attributes only, so they work under the strict CSP) -------------------

const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  plus: 'M12 5v14M5 12h14',
  book: 'M4 5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2zM4 20V5M8 7h8',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  chart: 'M4 20V11M10 20V5M16 20v-8M21 20H3',
  inbox: 'M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1.5 3h5L16 13h5',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M21.5 20a6.5 6.5 0 0 0-4-6',
  key: 'M8 21a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM11.5 12.5L20 4M16.5 7.5l2.5 2.5M14.5 9.5l2 2',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h4',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  check: 'M5 12.5l4.5 4.5L19 7',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  shield: 'M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  logout: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h10',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
};

export const icon = (name, cls = 'icon') => raw(
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`,
);

const logoMark = raw(`<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <path class="brand-shield" d="M16 2.5l11 4v8.3c0 7-4.8 11.6-11 13.2C9.8 26.4 5 21.8 5 14.8V6.5z"/>
  <path class="brand-frame" d="M10.5 11.5h11v9h-11z"/><path class="brand-hill" d="M10.5 18.5l3.2-3.2 2.6 2.6 1.6-1.6 3.6 3.6"/>
</svg>`);

/**
 * A dashboard statistic. Numeric values carry data-count so app.js can count up to them;
 * without JavaScript the final value is simply shown.
 */
export function stat({ label, value, count, sub, iconName, href, tone = '' }) {
  const inner = html`<span class="stat-icon">${icon(iconName)}</span>
    <span class="stat-label">${label}</span>
    <span class="stat-value" ${count !== undefined ? html`data-count="${count}"` : ''}>${count !== undefined ? bn(count) : value}</span>
    ${sub ? html`<span class="stat-sub">${sub}</span>` : ''}`;
  return href
    ? html`<a class="stat stat-link ${tone}" href="${href}">${inner}</a>`
    : html`<div class="stat ${tone}">${inner}</div>`;
}

const brand = html`<a class="brand" href="/">${logoMark}<span>${config.appName}</span></a>`;

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

/**
 * Animated "secure media vault": a shield with pulse rings, orbiting particles and media tiles
 * being scanned and marked verified/private. Pure HTML + CSS animation (no script, no inline
 * styles), hidden from assistive technology, and frozen for prefers-reduced-motion.
 */
const vaultScene = raw(`<div class="vault" aria-hidden="true">
  <div class="vault-grid"></div>
  <div class="vault-glow"></div>
  <div class="orbit orbit-a"><i></i><i></i><i></i></div>
  <div class="orbit orbit-b"><i></i><i></i></div>
  <div class="core">
    <span class="ring"></span><span class="ring"></span><span class="ring"></span>
    <svg class="core-shield" viewBox="0 0 64 64">
      <path class="shield-fill" d="M32 5l21 7.5v15.8c0 13.3-9.1 22.1-21 25.2-11.9-3.1-21-11.9-21-25.2V12.5z"/>
      <path class="shield-line" d="M32 5l21 7.5v15.8c0 13.3-9.1 22.1-21 25.2-11.9-3.1-21-11.9-21-25.2V12.5z"/>
      <rect class="lock-body" x="23" y="29" width="18" height="14" rx="3"/>
      <path class="lock-shackle" d="M26.5 29v-4a5.5 5.5 0 0 1 11 0v4"/>
      <circle class="lock-hole" cx="32" cy="36" r="2"/>
    </svg>
  </div>
  <div class="tile tile-a">
    <div class="tile-art art-sunset"><svg viewBox="0 0 80 50"><circle cx="58" cy="15" r="7"/><path d="M0 50 L22 24 L36 38 L48 28 L80 50Z"/></svg><span class="scanline"></span></div>
    <div class="tile-meta"><span class="ext">JPG</span><span class="chip chip-ok">✓ যাচাইকৃত</span></div>
  </div>
  <div class="tile tile-b">
    <div class="tile-art art-doc"><span></span><span></span><span></span><span></span><b>PDF</b></div>
    <div class="tile-meta"><span class="ext">PDF</span><span class="chip chip-lock">প্রাইভেট</span></div>
  </div>
  <div class="tile tile-c">
    <div class="tile-art art-ocean"><svg viewBox="0 0 80 50"><path d="M0 34 Q10 28 20 34 T40 34 T60 34 T80 34 V50 H0Z"/><path d="M0 42 Q10 36 20 42 T40 42 T60 42 T80 42 V50 H0Z"/></svg></div>
    <div class="tile-meta"><span class="ext">WEBP</span><span class="chip chip-cdn">⤢ ৩২০px</span></div>
  </div>
  <div class="tile tile-d"><span class="ext">AVIF</span></div>
  <div class="spark s1"></div><div class="spark s2"></div><div class="spark s3"></div>
</div>`);

/** Split layout for login, registration and account-recovery pages. */
export function authPage(req, { title, body }) {
  return documentShell({
    title,
    bodyClass: 'auth',
    body: html`<div class="auth-layout">
  <section class="auth-visual">
    ${vaultScene}
    <div class="vault-copy">
      <p class="eyebrow">সুরক্ষিত মিডিয়া লাইব্রেরি</p>
      <h2>আপনার ইমেজ ও PDF, নিরাপদ ভল্টে</h2>
      <ul class="trust">
        <li>${icon('scan')}<span>প্রতিটি আপলোড যাচাই ও পরিষ্কার করা হয়</span></li>
        <li>${icon('lock')}<span>প্রাইভেট ফাইল খোলে শুধু মেয়াদি signed লিংকে</span></li>
        <li>${icon('shield')}<span>API key, quota আর অডিট লগে পূর্ণ নিয়ন্ত্রণ</span></li>
      </ul>
    </div>
  </section>
  <main class="auth-main">
    <header class="auth-top">${brand}<a href="/docs" class="muted-link">API ডক ${icon('external', 'icon icon-sm')}</a></header>
    <div class="auth-body">${body}</div>
    <footer class="auth-foot">© ${bn(new Date().getFullYear())} ${config.appName} · সুরক্ষিত সংযোগ ${icon('lock', 'icon icon-sm')}</footer>
  </main>
</div>`,
  });
}

const USER_NAV = [
  ['/account', 'ড্যাশবোর্ড', 'overview', 'home'],
  ['/account/apps', 'আমার অ্যাপ ও API', 'apps', 'apps'],
  ['/account/apps/new', 'নতুন API অনুরোধ', 'new', 'plus'],
  ['/account/docs', 'ইন্টিগ্রেশন গাইড', 'docs', 'book'],
  ['/account/settings', 'অ্যাকাউন্ট সেটিংস', 'settings', 'sliders'],
];

const ADMIN_NAV = [
  ['/admin', 'ওভারভিউ', 'admin', 'chart'],
  ['/admin/requests', 'API অনুরোধ', 'requests', 'inbox'],
  ['/admin/users', 'ইউজার', 'users', 'users'],
  ['/admin/keys', 'সব API key', 'keys', 'key'],
  ['/admin/audit', 'অডিট লগ', 'audit', 'list'],
];

/** Logged-in dashboard with sidebar navigation. */
export function appPage(req, { title, active, body, flashCode, pendingCount = 0 }) {
  const csrf = req.session.csrf_token;
  const navLink = ([href, label, key, iconName], badgeCount) => html`<a href="${href}" class="${active === key ? 'active' : ''}" ${active === key ? raw('aria-current="page"') : ''}>
      ${icon(iconName)}<span class="nav-label">${label}</span>${badgeCount ? html`<span class="count">${bn(badgeCount)}</span>` : ''}</a>`;
  return documentShell({
    title,
    bodyClass: 'app',
    body: html`<div class="nav-progress" aria-hidden="true"></div>
<header class="topbar"><div class="topbar-inner">
  ${brand}
  <div class="topnav">
    <span class="whoami">${req.user.name}${req.user.role === 'admin' ? html` <span class="badge badge-info">অ্যাডমিন</span>` : ''}</span>
    ${logoutForm(csrf)}
  </div>
</div></header>
<div class="shell">
  <nav class="sidebar" aria-label="মেনু">
    <div class="nav-group"><div class="nav-title">আমার অ্যাকাউন্ট</div>${USER_NAV.map((l) => navLink(l))}<a href="/docs">${icon('external')}<span class="nav-label">API রেফারেন্স</span></a></div>
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
