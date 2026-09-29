import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Browser } from './helpers/browser.js';
import { startTestMysql } from './helpers/mysql.js';

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-server-recovery-'));
const mysqlServer = await startTestMysql();
Object.assign(process.env, {
  NODE_ENV: 'test',
  STORAGE_DIR: storageDir,
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef-XYZ',
  SIGNING_SECRET: 'test-signing-secret-0123456789abcdef-XYZ',
  PUBLIC_BASE_URL: 'http://media.test',
  MAIL_TRANSPORT: 'memory',
  RATE_LIMIT_LOGIN_FAILURES_PER_15MIN: '10000',
  RATE_LIMIT_REGISTRATIONS_PER_HOUR: '10000',
  RATE_LIMIT_PANEL_PER_15MIN: '100000',
  RATE_LIMIT_PASSWORD_RESETS_PER_15MIN: '10000',
});

const { createApp } = await import('../src/app.js');
const { closeDb, pool } = await import('../src/db.js');
const { migrate } = await import('../src/schema.js');
const { users } = await import('../src/accounts/repo.js');
const { hashPassword } = await import('../src/accounts/password.js');
const { outbox } = await import('../src/mail/mailer.js');

let server;
let base;
const PASSWORD = 'correct horse battery';
const ADMIN = { email: 'boss@example.com', password: 'boss password for tests' };

const browser = () => new Browser(base);
const lastMailTo = (email) => outbox.findLast((m) => m.to === email);
const mailsTo = (email) => outbox.filter((m) => m.to === email);
const tokenFrom = (mail, route) => new RegExp(`${route}\\?token=([\\w-]{43})`).exec(mail.text)?.[1];

async function register(b, email, name = 'Recovery User') {
  await b.get('/register');
  return b.post('/register', { name, email, password: PASSWORD, password_confirm: PASSWORD, terms: 'yes' });
}

async function verify(b, email) {
  const token = tokenFrom(lastMailTo(email), 'verify-email');
  await b.get(`/verify-email?token=${token}`);
  return b.post('/verify-email', { token });
}

before(async () => {
  await migrate();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await users.create({ name: 'Boss', email: ADMIN.email, passwordHash: await hashPassword(ADMIN.password), role: 'admin', emailVerified: true });
});

after(async () => {
  server.close();
  await closeDb();
  await mysqlServer.stop();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('email verification', () => {
  const email = 'verify@example.com';
  const b = new Browser('');

  before(() => { b.base = base; });

  test('registration sends a verification email with a one-time link', async () => {
    const res = await register(b, email);
    assert.equal(res.location, '/account?m=verify_sent');
    const mail = lastMailTo(email);
    assert.ok(mail, 'verification email sent');
    assert.match(mail.subject, /যাচাই/);
    assert.ok(tokenFrom(mail, 'verify-email'));
    assert.match(mail.html, /ইমেইল যাচাই করুন/);
  });

  test('unverified users see a banner and cannot request API access', async () => {
    const dash = await b.get('/account');
    assert.match(dash.text, /এখনো যাচাই করা হয়নি/);
    const form = await b.get('/account/apps/new');
    assert.equal(form.status, 303);
    assert.match(form.location, /verify_required/);
    const post = await b.post('/account/apps/new', { name: 'x' });
    assert.equal(post.status, 303);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM api_applications'))[0][0].n), 0);
  });

  test('resending is throttled', async () => {
    await b.get('/account');
    const res = await b.post('/account/verify/resend');
    assert.match(res.location, /verify_throttled/); // one was sent less than a minute ago
  });

  test('GET does not verify (link scanners); POST does, exactly once', async () => {
    const token = tokenFrom(lastMailTo(email), 'verify-email');
    const page = await b.get(`/verify-email?token=${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    let [[row]] = await pool.query('SELECT email_verified_at FROM users WHERE email = ?', [email]);
    assert.equal(row.email_verified_at, null);

    const res = await b.post('/verify-email', { token });
    assert.equal(res.location, '/account?m=email_verified');
    [[row]] = await pool.query('SELECT email_verified_at FROM users WHERE email = ?', [email]);
    assert.ok(row.email_verified_at);

    const reuse = await b.post('/verify-email', { token });
    assert.equal(reuse.status, 400);
    assert.doesNotMatch((await b.get('/account')).text, /এখনো যাচাই করা হয়নি/);
    assert.equal((await b.get('/account/apps/new')).status, 200);
  });

  test('tokens are stored hashed', async () => {
    const token = tokenFrom(lastMailTo(email), 'verify-email');
    const [rows] = await pool.query('SELECT id FROM user_tokens');
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.id !== token && r.id.length === 64));
  });

  test('garbage and expired tokens are rejected', async () => {
    assert.equal((await browser().get('/verify-email?token=nope')).status, 400);
    const other = browser();
    await register(other, 'expired@example.com');
    const token = tokenFrom(lastMailTo('expired@example.com'), 'verify-email');
    await pool.query("UPDATE user_tokens SET expires_at = '2000-01-01' WHERE purpose = 'verify_email' AND used_at IS NULL");
    assert.equal((await other.get(`/verify-email?token=${token}`)).status, 400);
  });
});

describe('forgot / reset password', () => {
  const email = 'forgot@example.com';

  before(async () => {
    const b = browser();
    await register(b, email);
    await verify(b, email);
  });

  test('unknown and known emails get the same response; only known ones get mail', async () => {
    const before = outbox.length;
    const unknown = browser();
    await unknown.get('/forgot-password');
    const a = await unknown.post('/forgot-password', { email: 'ghost@example.com' });
    assert.equal(outbox.length, before);

    const known = browser();
    await known.get('/forgot-password');
    const b = await known.post('/forgot-password', { email: 'FORGOT@example.com' });
    assert.equal(a.status, b.status);
    assert.match(a.text, /ইমেইল দেখুন/);
    assert.match(b.text, /ইমেইল দেখুন/);
    assert.ok(tokenFrom(lastMailTo(email), 'reset-password'));
  });

  test('a newer reset link invalidates the older one', async () => {
    const first = tokenFrom(lastMailTo(email), 'reset-password');
    const b = browser();
    await b.get('/forgot-password');
    await b.post('/forgot-password', { email });
    const second = tokenFrom(lastMailTo(email), 'reset-password');
    assert.notEqual(first, second);
    assert.equal((await browser().get(`/reset-password?token=${first}`)).status, 400);
    assert.equal((await browser().get(`/reset-password?token=${second}`)).status, 200);
  });

  test('reset validates the new password, then signs out everywhere and notifies', async () => {
    const phone = browser();
    await phone.login(email, PASSWORD);
    assert.equal((await phone.get('/account')).status, 200);

    const token = tokenFrom(lastMailTo(email), 'reset-password');
    const b = browser();
    await b.get(`/reset-password?token=${token}`);
    const weak = await b.post('/reset-password', { token, password: 'short', password_confirm: 'short' });
    assert.equal(weak.status, 422);

    const ok = await b.post('/reset-password', { token, password: 'a totally new passphrase', password_confirm: 'a totally new passphrase' });
    assert.equal(ok.location, '/login?m=password_reset');
    assert.equal((await phone.get('/account')).status, 303, 'old session revoked');
    assert.equal((await browser().login(email, PASSWORD)).status, 401);
    assert.equal((await browser().login(email, 'a totally new passphrase')).status, 303);
    assert.match(lastMailTo(email).subject, /পাসওয়ার্ড বদলানো হয়েছে/);

    const again = browser();
    await again.get('/login');
    assert.equal((await again.post('/reset-password', { token, password: 'yet another passphrase', password_confirm: 'yet another passphrase' })).status, 400);
  });

  test('reset links are rate limited per account', async () => {
    const before = mailsTo(email).length;
    for (let i = 0; i < 5; i++) {
      const b = browser();
      await b.get('/forgot-password');
      await b.post('/forgot-password', { email });
    }
    assert.ok(mailsTo(email).length - before <= 3);
  });

  test('a reset also unlocks a locked account and verifies the email', async () => {
    const lockedEmail = 'locked@example.com';
    await register(browser(), lockedEmail);
    for (let i = 0; i < 5; i++) await browser().login(lockedEmail, 'wrong password!!');
    assert.match((await browser().login(lockedEmail, PASSWORD)).text, /লক/);

    const b = browser();
    await b.get('/forgot-password');
    await b.post('/forgot-password', { email: lockedEmail });
    const token = tokenFrom(lastMailTo(lockedEmail), 'reset-password');
    await b.get(`/reset-password?token=${token}`);
    await b.post('/reset-password', { token, password: 'fresh start passphrase', password_confirm: 'fresh start passphrase' });
    assert.equal((await browser().login(lockedEmail, 'fresh start passphrase')).status, 303);
    const [[row]] = await pool.query('SELECT email_verified_at FROM users WHERE email = ?', [lockedEmail]);
    assert.ok(row.email_verified_at);
  });

  test('the login page links to password recovery', async () => {
    assert.match((await browser().get('/login')).text, /href="\/forgot-password"/);
  });
});

describe('admin: invitations and recovery', () => {
  const admin = new Browser('');
  before(async () => {
    admin.base = base;
    await admin.login(ADMIN.email, ADMIN.password);
  });

  test('an admin invites another admin, who sets a password from the email', async () => {
    await admin.get('/admin/users/new');
    const res = await admin.post('/admin/users/new', { name: 'Second Admin', email: 'second@example.com', role: 'admin' });
    assert.match(res.location, /m=invite_sent/);
    const mail = lastMailTo('second@example.com');
    assert.match(mail.subject, /আমন্ত্রণ/);
    assert.match(mail.html, /অ্যাডমিন/);

    // The account cannot be used before accepting.
    const [[row]] = await pool.query("SELECT email_verified_at, role FROM users WHERE email = 'second@example.com'");
    assert.equal(row.email_verified_at, null);
    assert.equal(row.role, 'admin');

    const token = tokenFrom(mail, 'reset-password');
    const invitee = browser();
    const page = await invitee.get(`/reset-password?token=${token}`);
    assert.match(page.text, /অ্যাকাউন্ট চালু করুন/);
    const done = await invitee.post('/reset-password', { token, password: 'trusted keeper of media', password_confirm: 'trusted keeper of media' });
    assert.equal(done.location, '/login?m=invite_accepted');
    const login = await invitee.login('second@example.com', 'trusted keeper of media');
    assert.equal(login.location, '/admin');
    assert.equal((await invitee.get('/admin')).status, 200);
  });

  test('duplicate or invalid invitations are refused', async () => {
    await admin.get('/admin/users/new');
    assert.equal((await admin.post('/admin/users/new', { name: 'Dup', email: 'second@example.com', role: 'user' })).status, 422);
    await admin.get('/admin/users/new');
    assert.equal((await admin.post('/admin/users/new', { name: 'Bad', email: 'nope', role: 'root' })).status, 422);
  });

  test('an unverified admin cannot open the admin panel', async () => {
    const b = browser();
    await register(b, 'wannabe@example.com');
    await pool.query("UPDATE users SET role = 'admin' WHERE email = 'wannabe@example.com'");
    const again = browser();
    await again.login('wannabe@example.com', PASSWORD);
    const res = await again.get('/admin');
    assert.equal(res.status, 403);
    assert.match(res.text, /ইমেইল যাচাই করুন/);
  });

  test('admin can send a reset link, resend verification and mark verified', async () => {
    const [[user]] = await pool.query("SELECT id FROM users WHERE email = 'expired@example.com'");
    await admin.get(`/admin/users/${user.id}`);
    const before = mailsTo('expired@example.com').length;
    const reset = await admin.post(`/admin/users/${user.id}/send-reset`);
    assert.match(reset.location, /reset_link_sent/);
    assert.equal(mailsTo('expired@example.com').length, before + 1);
    assert.ok(tokenFrom(lastMailTo('expired@example.com'), 'reset-password'));

    await admin.get(`/admin/users/${user.id}`);
    const marked = await admin.post(`/admin/users/${user.id}/verify`);
    assert.match(marked.location, /marked_verified/);
    const [[row]] = await pool.query('SELECT email_verified_at FROM users WHERE id = ?', [user.id]);
    assert.ok(row.email_verified_at);
  });
});

describe('notifications', () => {
  test('admins are told about new requests; users about the decision', async () => {
    const email = 'notify@example.com';
    const user = browser();
    await register(user, email, 'Notify Me');
    await verify(user, email);
    await user.get('/account/apps/new');
    const res = await user.post('/account/apps/new', {
      name: 'Photo\r\nBcc: victim@example.com', purpose: 'Hosting product photos for our online store.', expected_volume: 'lt1k', scopes: 'upload',
    });
    const appId = /apps\/(\d+)/.exec(res.location)[1];

    const adminMail = lastMailTo(ADMIN.email);
    assert.match(adminMail.subject, /নতুন API অনুরোধ/);
    assert.doesNotMatch(adminMail.subject, /[\r\n]/, 'no header injection');
    assert.ok(adminMail.text.includes(`/admin/requests/${appId}`));

    const admin = browser();
    await admin.login(ADMIN.email, ADMIN.password);
    await admin.get(`/admin/requests/${appId}`);
    await admin.post(`/admin/requests/${appId}/approve`, { scopes: 'upload', quota_mb: '10', origins: '', note: 'Welcome aboard' });
    const decision = lastMailTo(email);
    assert.match(decision.subject, /অনুমোদিত/);
    assert.match(decision.text, /Welcome aboard/);
    assert.ok(decision.text.includes(`/account/apps/${appId}`));
  });
});
