import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { startTestMysql } from './helpers/mysql.js';

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-server-accounts-'));
const mysqlServer = await startTestMysql();
Object.assign(process.env, {
  NODE_ENV: 'test',
  STORAGE_DIR: storageDir,
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef-XYZ',
  SIGNING_SECRET: 'test-signing-secret-0123456789abcdef-XYZ',
  PUBLIC_BASE_URL: 'http://127.0.0.1:0', // replaced below once the port is known
  RATE_LIMIT_API_PER_15MIN: '10000',
  RATE_LIMIT_AUTH_FAILURES_PER_15MIN: '10000',
  RATE_LIMIT_LOGIN_FAILURES_PER_15MIN: '10000',
  RATE_LIMIT_REGISTRATIONS_PER_HOUR: '10000',
  RATE_LIMIT_PANEL_PER_15MIN: '100000',
  MAX_LOGIN_FAILURES: '3',
  MAIL_TRANSPORT: 'memory',
});

const { createApp } = await import('../src/app.js');
const { closeDb, pool } = await import('../src/db.js');
const { migrate } = await import('../src/schema.js');
const { users } = await import('../src/accounts/repo.js');
const { hashPassword } = await import('../src/accounts/password.js');
const { outbox } = await import('../src/mail/mailer.js');

let server;
let base;
let png;

/** Minimal browser: keeps cookies, sends same-origin Origin headers, extracts CSRF tokens. */
class Browser {
  constructor() {
    this.cookies = new Map();
  }

  headers(extra = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return { ...(cookie ? { Cookie: cookie } : {}), ...extra };
  }

  store(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const [name, value] = pair.split('=');
      const expired = attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a));
      if (expired || value === '') this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
  }

  async get(url) {
    const res = await fetch(base + url, { headers: this.headers(), redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    this.lastCsrf = /name="_csrf" value="([^"]+)"/.exec(text)?.[1] ?? this.lastCsrf;
    return { status: res.status, text, headers: res.headers };
  }

  async post(url, fields = {}, { origin = base, csrf = this.lastCsrf } = {}) {
    const body = new URLSearchParams();
    if (csrf !== null) body.append('_csrf', csrf ?? '');
    for (const [k, v] of Object.entries(fields)) {
      for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
    }
    const res = await fetch(base + url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) }),
      body,
      redirect: 'manual',
    });
    this.store(res);
    const text = await res.text();
    this.lastCsrf = /name="_csrf" value="([^"]+)"/.exec(text)?.[1] ?? this.lastCsrf;
    return { status: res.status, text, location: res.headers.get('location'), headers: res.headers };
  }
}

/** Registers and (unless verify: false) clicks the emailed verification link, like a real user. */
async function register(browser, { name = 'Test User', email, password = 'correct horse battery', verify = true }) {
  await browser.get('/register');
  const res = await browser.post('/register', { name, email, password, password_confirm: password, terms: 'yes' });
  if (verify && res.status === 303) {
    const mail = outbox.findLast((m) => m.to === email.toLowerCase());
    const token = /verify-email\?token=([\w-]{43})/.exec(mail.text)[1];
    await browser.get(`/verify-email?token=${token}`);
    await browser.post('/verify-email', { token });
  }
  return res;
}

async function login(browser, email, password) {
  await browser.get('/login');
  return browser.post('/login', { email, password });
}

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin password for tests';

before(async () => {
  await migrate();
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#09f' } }).png().toBuffer();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await users.create({ name: 'Admin', email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'admin', emailVerified: true });
});

after(async () => {
  server.close();
  await closeDb();
  await mysqlServer.stop();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('registration', () => {
  test('landing page renders', async () => {
    const res = await new Browser().get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /রেজিস্ট্রেশন/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  });

  test('creates an account and logs the user in with a hardened cookie', async () => {
    const b = new Browser();
    const res = await register(b, { email: 'Alice@Example.com' });
    assert.equal(res.status, 303);
    assert.equal(res.location, '/account?m=verify_sent');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('ms_session='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const dash = await b.get('/account');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /স্বাগতম, Test User/);
    // Stored lower-cased, password hashed with scrypt.
    const [[row]] = await pool.query("SELECT email, password_hash FROM users WHERE email = 'alice@example.com'");
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes('correct horse'));
  });

  test('validates input and rejects duplicate emails', async () => {
    const b = new Browser();
    let res = await register(b, { email: 'not-an-email', password: 'short' });
    assert.equal(res.status, 422);
    assert.match(res.text, /সঠিক ইমেইল/);
    assert.match(res.text, /কমপক্ষে ১০ অক্ষর/);
    res = await register(new Browser(), { email: 'alice@example.com' });
    assert.equal(res.status, 422);
    assert.match(res.text, /আগেই অ্যাকাউন্ট/);
  });

  test('stores no plaintext session token in the database', async () => {
    const b = new Browser();
    await register(b, { email: 'token@example.com' });
    const token = b.cookies.get('ms_session');
    const [rows] = await pool.query('SELECT id FROM sessions');
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.id !== token));
  });
});

describe('login security', () => {
  test('wrong password and unknown email give the same generic error', async () => {
    const a = await login(new Browser(), 'alice@example.com', 'wrong password!!');
    const b = await login(new Browser(), 'nobody@example.com', 'wrong password!!');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.match(a.text, /ইমেইল বা পাসওয়ার্ড সঠিক নয়/);
    assert.match(b.text, /ইমেইল বা পাসওয়ার্ড সঠিক নয়/);
  });

  test('locks the account after repeated failures', async () => {
    await register(new Browser(), { email: 'lock@example.com' });
    for (let i = 0; i < 3; i++) await login(new Browser(), 'lock@example.com', 'bad password xx');
    const res = await login(new Browser(), 'lock@example.com', 'correct horse battery');
    assert.equal(res.status, 401);
    assert.match(res.text, /লক/);
  });

  test('rejects POSTs without a valid CSRF token or from another origin', async () => {
    const b = new Browser();
    await b.get('/login');
    const noToken = await b.post('/login', { email: 'alice@example.com', password: 'correct horse battery' }, { csrf: null });
    assert.equal(noToken.status, 403);
    await b.get('/login');
    const crossSite = await b.post('/login', { email: 'alice@example.com', password: 'correct horse battery' }, { origin: 'https://evil.example' });
    assert.equal(crossSite.status, 403);
  });

  test('does not allow open redirects after login', async () => {
    const b = new Browser();
    await b.get('/login');
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const res = await b.post('/login', { email: 'alice@example.com', password: 'correct horse battery', next });
      assert.equal(res.status, 303);
      assert.ok(res.location.startsWith('/') && !res.location.startsWith('//') && !res.location.startsWith('/\\'), res.location);
      await b.get('/account'); // pick up the session's CSRF token
      await b.post('/logout', {});
      await b.get('/login');
    }
  });

  test('logout invalidates the session server-side', async () => {
    const b = new Browser();
    await login(b, 'alice@example.com', 'correct horse battery');
    const stolen = b.cookies.get('ms_session');
    await b.get('/account');
    await b.post('/logout', {});
    const replay = await fetch(`${base}/account`, { headers: { Cookie: `ms_session=${stolen}` }, redirect: 'manual' });
    assert.equal(replay.status, 303);
    assert.match(replay.headers.get('location'), /^\/login/);
  });

  test('protected pages redirect to login; users cannot open the admin panel', async () => {
    const anon = await new Browser().get('/account');
    assert.equal(anon.status, 303);
    const b = new Browser();
    await login(b, 'alice@example.com', 'correct horse battery');
    assert.equal((await b.get('/admin')).status, 403);
    assert.equal((await b.get('/admin/users')).status, 403);
  });
});

describe('API request → approval → key → upload', () => {
  const user = new Browser();
  const admin = new Browser();
  let appId;
  let apiKey;

  before(async () => {
    await register(user, { name: 'Shop Owner', email: 'shop@example.com' });
    await login(admin, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('user submits a request (content is escaped)', async () => {
    await user.get('/account/apps/new');
    const res = await user.post('/account/apps/new', {
      name: '<script>alert(1)</script> Shop',
      website: 'https://shop.example.com',
      purpose: 'বিক্রেতারা প্রোডাক্টের ছবি আপলোড করবেন, মাসে প্রায় ৫০০টি।',
      expected_volume: 'lt1k',
      scopes: ['upload', 'read'],
      origins: 'https://shop.example.com',
    });
    assert.equal(res.status, 303);
    appId = /\/account\/apps\/(\d+)/.exec(res.location)[1];
    const page = await user.get(`/account/apps/${appId}`);
    assert.match(page.text, /অপেক্ষমাণ/);
    assert.ok(!page.text.includes('<script>alert(1)</script>'));
    assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  test('invalid requests are rejected with field errors', async () => {
    await user.get('/account/apps/new');
    const res = await user.post('/account/apps/new', { name: 'x', purpose: 'short', expected_volume: 'bogus', origins: 'javascript:alert(1)' });
    assert.equal(res.status, 422);
    assert.match(res.text, /অন্তত একটি অনুমতি/);
  });

  test('another user cannot see the request', async () => {
    const other = new Browser();
    await login(other, 'alice@example.com', 'correct horse battery');
    assert.equal((await other.get(`/account/apps/${appId}`)).status, 404);
  });

  test('pending apps cannot generate keys', async () => {
    await user.get(`/account/apps/${appId}`);
    assert.equal((await user.post(`/account/apps/${appId}/key`, {})).status, 409);
  });

  test('admin sees the pending request and approves it with adjusted limits', async () => {
    const list = await admin.get('/admin/requests?status=pending');
    assert.ok(list.text.includes(`/admin/requests/${appId}`));
    await admin.get(`/admin/requests/${appId}`);
    const res = await admin.post(`/admin/requests/${appId}/approve`, {
      scopes: ['upload', 'read'], quota_mb: '5', origins: 'https://shop.example.com', note: 'স্বাগতম!',
    });
    assert.equal(res.status, 303);
    assert.match(res.location, /m=approved/);
    // Approving twice is refused.
    await admin.get(`/admin/requests/${appId}`);
    const again = await admin.post(`/admin/requests/${appId}/approve`, { scopes: ['upload'], quota_mb: '5', origins: '' });
    assert.match(again.location, /m=not_pending/);
  });

  test('user generates a key, shown once, which works against the API', async () => {
    const page = await user.get(`/account/apps/${appId}`);
    assert.match(page.text, /API key তৈরি করুন/);
    const res = await user.post(`/account/apps/${appId}/key`, {});
    assert.equal(res.status, 200);
    apiKey = /ms_[A-Za-z0-9_-]{43}/.exec(res.text)[0];
    const after = await user.get(`/account/apps/${appId}`);
    assert.ok(!after.text.includes(apiKey), 'full key must not be shown again');

    const form = new FormData();
    form.append('image', new Blob([png]), 'p.png');
    const up = await fetch(`${base}/api/v1/upload`, { method: 'POST', headers: { 'X-API-Key': apiKey }, body: form });
    assert.equal(up.status, 201);
    const me = await (await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': apiKey } })).json();
    assert.equal(me.data.quota_bytes, 5 * 1048576);
    assert.deepEqual(me.data.scopes, ['upload', 'read']);
    assert.deepEqual(me.data.allowed_origins, ['https://shop.example.com']);
  });

  test('files appear in the dashboard file manager and can be deleted there', async () => {
    const page = await user.get(`/account/apps/${appId}/files`);
    const fileId = /\/files\/([\w-]{16})\/delete/.exec(page.text)[1];
    const res = await user.post(`/account/apps/${appId}/files/${fileId}/delete`, {});
    assert.equal(res.status, 303);
    assert.equal((await fetch(`${base}/api/v1/files/${fileId}`, { headers: { 'X-API-Key': apiKey } })).status, 404);
  });

  test('integration guide is personalised for the app', async () => {
    const page = await user.get(`/account/docs?app=${appId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /\/api\/v1\/upload/);
    assert.ok(page.text.includes(apiKey.slice(0, 7)), 'guide shows the key prefix');
    assert.ok(page.text.includes('https://shop.example.com'));
  });

  test('rotating the key disables the old one', async () => {
    await user.get(`/account/apps/${appId}`);
    const res = await user.post(`/account/apps/${appId}/key`, {});
    const newKey = /ms_[A-Za-z0-9_-]{43}/.exec(res.text)[0];
    assert.notEqual(newKey, apiKey);
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': apiKey } })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': newKey } })).status, 200);
    apiKey = newKey;
  });

  test('revoking access stops the key; reactivating restores it', async () => {
    await admin.get(`/admin/requests/${appId}`);
    await admin.post(`/admin/requests/${appId}/revoke`, { note: 'নীতিমালা লঙ্ঘন' });
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': apiKey } })).status, 401);
    assert.match((await user.get(`/account/apps/${appId}`)).text, /নীতিমালা লঙ্ঘন/);
    await admin.get(`/admin/requests/${appId}`);
    await admin.post(`/admin/requests/${appId}/reactivate`, {});
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': apiKey } })).status, 200);
  });

  test('suspending the user disables their keys and sessions', async () => {
    const [[row]] = await pool.query("SELECT id FROM users WHERE email = 'shop@example.com'");
    await admin.get(`/admin/users/${row.id}`);
    await admin.post(`/admin/users/${row.id}/status`, { status: 'suspended' });
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': apiKey } })).status, 401);
    assert.equal((await user.get('/account')).status, 303);
    assert.equal((await login(new Browser(), 'shop@example.com', 'correct horse battery')).status, 401);
    await admin.get(`/admin/users/${row.id}`);
    await admin.post(`/admin/users/${row.id}/status`, { status: 'active' });
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': apiKey } })).status, 200);
  });

  test('admin can reject with a reason the user sees', async () => {
    await user.get('/login');
    await login(user, 'shop@example.com', 'correct horse battery');
    await user.get('/account/apps/new');
    const res = await user.post('/account/apps/new', {
      name: 'Second app', purpose: 'Another project that needs image hosting for blog posts.', expected_volume: '1k-10k', scopes: 'upload',
    });
    const id = /\/account\/apps\/(\d+)/.exec(res.location)[1];
    await admin.get(`/admin/requests/${id}`);
    const empty = await admin.post(`/admin/requests/${id}/reject`, { note: '' });
    assert.equal(empty.status, 422);
    await admin.post(`/admin/requests/${id}/reject`, { note: 'ওয়েবসাইটের লিংক দিন' });
    const page = await user.get(`/account/apps/${id}`);
    assert.match(page.text, /প্রত্যাখ্যাত/);
    assert.match(page.text, /ওয়েবসাইটের লিংক দিন/);
  });

  test('admin cannot suspend or demote themselves', async () => {
    const [[row]] = await pool.query('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
    await admin.get(`/admin/users/${row.id}`);
    const res = await admin.post(`/admin/users/${row.id}/status`, { status: 'suspended' });
    assert.match(res.location, /cannot_self/);
  });

  test('actions are recorded in the audit log', async () => {
    const page = await admin.get('/admin/audit');
    for (const label of ['অনুমোদন', 'key তৈরি', 'key rotate', 'অ্যাক্সেস বাতিল', 'ইউজার স্থগিত', 'প্রত্যাখ্যান']) {
      assert.ok(page.text.includes(label), label);
    }
  });
});

describe('account settings', () => {
  test('changing the password signs out other sessions', async () => {
    const email = 'settings@example.com';
    const laptop = new Browser();
    const phone = new Browser();
    await register(laptop, { email });
    await login(phone, email, 'correct horse battery');
    await laptop.get('/account/settings');
    const wrong = await laptop.post('/account/settings/password', { current_password: 'nope', password: 'a brand new passphrase', password_confirm: 'a brand new passphrase' });
    assert.equal(wrong.status, 422);
    await laptop.get('/account/settings');
    const ok = await laptop.post('/account/settings/password', { current_password: 'correct horse battery', password: 'a brand new passphrase', password_confirm: 'a brand new passphrase' });
    assert.equal(ok.status, 303);
    assert.equal((await laptop.get('/account')).status, 200);
    assert.equal((await phone.get('/account')).status, 303);
    assert.equal((await login(new Browser(), email, 'a brand new passphrase')).status, 303);
  });
});
