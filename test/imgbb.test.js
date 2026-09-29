import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { startTestMysql } from './helpers/mysql.js';

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-server-imgbb-'));
const mysqlServer = await startTestMysql();
Object.assign(process.env, {
  NODE_ENV: 'test',
  STORAGE_DIR: storageDir,
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef-XYZ',
  SIGNING_SECRET: 'test-signing-secret-0123456789abcdef-XYZ',
  MAX_FILE_SIZE_MB: '2',
  PUBLIC_BASE_URL: 'http://media.test',
  RATE_LIMIT_API_PER_15MIN: '10000',
  RATE_LIMIT_AUTH_FAILURES_PER_15MIN: '10000',
});

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { migrate } = await import('../src/schema.js');
const { config } = await import('../src/config.js');
const { ensureStorage } = await import('../src/services/storage.js');
const { isBlockedAddress } = await import('../src/services/remote.js');

let server;
let origin; // a separate "external website" serving test images
let base;
let external;
let apiKey;
let browserKey;

const ADMIN = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const local = (publicUrl) => {
  const u = new URL(publicUrl);
  return base + u.pathname + u.search;
};

let png;

async function createKey(body) {
  const res = await fetch(`${base}/api/v1/admin/keys`, {
    method: 'POST',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()).data;
}

const postJson = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  await migrate();
  await ensureStorage();
  png = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#39c' } }).png().toBuffer();

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  origin = http.createServer((req, res) => {
    if (req.url === '/cat.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    if (req.url === '/redirect') return res.writeHead(302, { Location: '/cat.png' }).end();
    if (req.url === '/loop') return res.writeHead(302, { Location: '/loop' }).end();
    if (req.url === '/to-metadata') return res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
    if (req.url === '/huge') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(3 * 1024 * 1024));
    if (req.url === '/page.html') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><script>alert(1)</script></html>');
    res.writeHead(404).end();
  }).listen(0);
  await new Promise((r) => origin.once('listening', r));
  external = `http://127.0.0.1:${origin.address().port}`;

  apiKey = (await createKey({ name: 'server app' })).key;
  browserKey = (await createKey({ name: 'browser', scopes: ['upload'], allowed_origins: ['https://mysite.com', 'https://*.shop.com'] })).key;
});

after(async () => {
  server.close();
  await closeDb();
  await mysqlServer.stop();
  origin.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('upload sources', () => {
  test('base64 via JSON', async () => {
    const res = await postJson(`${base}/api/v1/upload`, { image: png.toString('base64'), name: 'b64.png' }, { 'X-API-Key': apiKey });
    const { data } = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.title, 'b64.png');
    assert.equal(data.width, 900);
    assert.match(data.delete_url, /\/d\/[\w-]{16}\/[\w-]{32}$/);
    assert.match(data.viewer_url, /\/v\/[\w-]{16}$/);
  });

  test('data: URI via urlencoded form', async () => {
    const body = new URLSearchParams({ image: `data:image/png;base64,${png.toString('base64')}` });
    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', headers: { 'X-API-Key': apiKey }, body });
    assert.equal(res.status, 201);
  });

  test('rejects invalid base64', async () => {
    const res = await postJson(`${base}/api/v1/upload`, { image: 'not base64!!' }, { 'X-API-Key': apiKey });
    assert.equal(res.status, 400);
  });

  test('rejects base64 over the size limit before decoding', async () => {
    const res = await postJson(`${base}/api/v1/upload`, { image: 'A'.repeat(2.9 * 1024 * 1024) }, { 'X-API-Key': apiKey });
    assert.equal(res.status, 413);
  });

  test('requires an image', async () => {
    const res = await postJson(`${base}/api/v1/upload`, { name: 'x' }, { 'X-API-Key': apiKey });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'missing_image');
  });
});

describe('remote URL uploads (SSRF protection)', () => {
  test('blocks private, loopback and metadata addresses', async () => {
    for (const url of [
      `${external}/cat.png`, // 127.0.0.1
      'http://localhost/cat.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/x.png',
      'http://192.168.1.1/x.png',
      'http://[::1]/x.png',
      'http://[::ffff:127.0.0.1]/x.png',
      'http://2130706433/x.png', // 127.0.0.1 as an integer
      'http://0x7f.1/x.png',
      'http://0/x.png',
    ]) {
      const res = await postJson(`${base}/api/v1/upload`, { image: url }, { 'X-API-Key': apiKey });
      const body = await res.json();
      assert.ok([400, 422].includes(res.status), `${url} -> ${res.status}`);
      assert.notEqual(body.error.code, 'unsupported_type', url);
    }
  });

  test('rejects non-http schemes, credentials and odd ports', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/a.png', 'http://user:pw@example.com/a.png', 'http://example.com:6379/']) {
      const res = await postJson(`${base}/api/v1/upload`, { image: url }, { 'X-API-Key': apiKey });
      assert.ok([400, 413, 415].includes(res.status) || res.status === 400, `${url} -> ${res.status}`);
      assert.notEqual(res.status, 201, url);
    }
  });

  test('address classifier', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001::200e']) assert.equal(isBlockedAddress(ip), false, ip);
  });

  describe('with a reachable test origin', () => {
    before(() => { config.remoteUpload.allowPrivateNetworks = true; });
    after(() => { config.remoteUpload.allowPrivateNetworks = false; });

    test('downloads, validates and stores the image', async () => {
      const res = await postJson(`${base}/api/v1/upload`, { image: `${external}/cat.png` }, { 'X-API-Key': apiKey });
      const { data } = await res.json();
      assert.equal(res.status, 201);
      assert.equal(data.title, 'cat.png');
      assert.equal(data.mime, 'image/png');
    });

    test('follows a limited number of redirects', async () => {
      assert.equal((await postJson(`${base}/api/v1/upload`, { image: `${external}/redirect` }, { 'X-API-Key': apiKey })).status, 201);
      assert.equal((await postJson(`${base}/api/v1/upload`, { image: `${external}/loop` }, { 'X-API-Key': apiKey })).status, 422);
    });

    test('rejects oversized and non-image responses', async () => {
      assert.equal((await postJson(`${base}/api/v1/upload`, { image: `${external}/huge` }, { 'X-API-Key': apiKey })).status, 413);
      assert.equal((await postJson(`${base}/api/v1/upload`, { image: `${external}/page.html` }, { 'X-API-Key': apiKey })).status, 415);
      assert.equal((await postJson(`${base}/api/v1/upload`, { image: `${external}/missing.png` }, { 'X-API-Key': apiKey })).status, 422);
    });
  });

  test('fetchRemote itself refuses the cloud metadata address', async () => {
    const { fetchRemote } = await import('../src/services/remote.js');
    await assert.rejects(fetchRemote('http://169.254.169.254/latest/meta-data/'), { code: 'remote_url_blocked' });
  });
});

describe('imgbb-compatible endpoint', () => {
  let data;

  test('POST /1/upload?key= returns the imgbb response shape', async () => {
    const form = new FormData();
    form.append('image', new Blob([png]), 'holiday.png');
    const res = await fetch(`${base}/1/upload?key=${apiKey}&expiration=600`, { method: 'POST', body: form });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, 200);
    data = body.data;
    for (const k of ['id', 'title', 'url_viewer', 'url', 'display_url', 'width', 'height', 'size', 'time', 'expiration', 'image', 'thumb', 'medium', 'delete_url']) {
      assert.ok(k in data, `missing ${k}`);
    }
    assert.equal(data.width, '900');
    assert.equal(data.expiration, '600');
    assert.equal(data.title, 'holiday');
    assert.equal(data.image.filename, 'holiday.png');
    assert.match(data.medium.url, /w=640/);
    const thumb = await fetch(local(data.thumb.url));
    assert.equal(thumb.status, 200);
    assert.equal((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width, 180);
  });

  test('accepts the key as a form field', async () => {
    const form = new FormData();
    form.append('key', apiKey);
    form.append('image', png.toString('base64'));
    const res = await fetch(`${base}/1/upload`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
  });

  test('errors use imgbb format', async () => {
    const res = await fetch(`${base}/1/upload`, { method: 'POST', body: new URLSearchParams({ image: 'x' }) });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.status_code, 401);
    assert.equal(body.status_txt, 'Unauthorized');
    assert.ok(body.error.message);
  });

  test('rejects a bad query key before reading the body', async () => {
    const res = await fetch(`${base}/1/upload?key=ms_wrong`, { method: 'POST', body: new URLSearchParams({ image: 'x' }) });
    assert.equal(res.status, 401);
  });
});

describe('cross-origin (browser) access', () => {
  const upload = (key, originHeader) => {
    const form = new FormData();
    form.append('image', new Blob([png]), 'x.png');
    return fetch(`${base}/api/v1/upload`, { method: 'POST', headers: { 'X-API-Key': key, Origin: originHeader }, body: form });
  };

  test('preflight is answered with CORS headers', async () => {
    const res = await fetch(`${base}/api/v1/upload`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://mysite.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://mysite.com');
    assert.match(res.headers.get('access-control-allow-headers'), /X-API-Key/);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  test('allows origins on the key allow-list, including wildcard subdomains', async () => {
    const ok = await upload(browserKey, 'https://mysite.com');
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://mysite.com');
    assert.equal((await upload(browserKey, 'https://store.shop.com')).status, 201);
  });

  test('rejects other origins', async () => {
    for (const o of ['https://evil.com', 'http://mysite.com', 'https://mysite.com.evil.com', 'https://shop.com', 'https://evilshop.com', 'null']) {
      const res = await upload(browserKey, o);
      assert.equal(res.status, 403, o);
      assert.equal((await res.json()).error.code, 'origin_not_allowed');
    }
  });

  test('keys without allowed_origins are server-side only', async () => {
    assert.equal((await upload(apiKey, 'https://mysite.com')).status, 403);
  });

  test('upload-only browser key cannot list or delete', async () => {
    const res = await fetch(`${base}/api/v1/files`, { headers: { 'X-API-Key': browserKey, Origin: 'https://mysite.com' } });
    assert.equal(res.status, 403);
  });

  test('admin API has no CORS', async () => {
    const res = await fetch(`${base}/api/v1/admin/keys`, { method: 'OPTIONS', headers: { Origin: 'https://mysite.com', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('rejects malformed allowed_origins', async () => {
    const res = await fetch(`${base}/api/v1/admin/keys`, {
      method: 'POST',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad', allowed_origins: ['javascript:alert(1)'] }),
    });
    assert.equal(res.status, 400);
  });
});

describe('viewer and delete pages', () => {
  let file;

  before(async () => {
    const res = await postJson(`${base}/api/v1/upload`, { image: png.toString('base64'), name: '"><script>alert(1)</script>.png' }, { 'X-API-Key': apiKey });
    file = (await res.json()).data;
  });

  test('viewer page escapes user content and has a strict CSP', async () => {
    const res = await fetch(local(file.viewer_url));
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)'));
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok(html.includes('[img]'), 'BBCode embed');
  });

  test('private files have no viewer page', async () => {
    const res = await postJson(`${base}/api/v1/upload`, { image: png.toString('base64'), visibility: 'private' }, { 'X-API-Key': apiKey });
    const { data } = await res.json();
    assert.equal(data.viewer_url, null);
    assert.equal((await fetch(`${base}/v/${data.id}`)).status, 404);
  });

  test('GET on a delete link does not delete', async () => {
    const res = await fetch(local(file.delete_url));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<form method="post"/);
    assert.equal((await fetch(local(file.url))).status, 200);
  });

  test('wrong token is rejected', async () => {
    const wrong = local(file.delete_url).replace(/[\w-]{32}$/, 'A'.repeat(32));
    assert.equal((await fetch(wrong, { method: 'POST' })).status, 404);
    assert.equal((await fetch(local(file.url))).status, 200);
  });

  test('POST on the delete link deletes the file', async () => {
    const res = await fetch(local(file.delete_url), { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await fetch(local(file.url))).status, 404);
    assert.equal((await fetch(local(file.delete_url), { method: 'POST' })).status, 404);
  });
});

describe('documentation', () => {
  test('serves the OpenAPI spec and Swagger UI', async () => {
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.equal(spec.openapi, '3.1.0');
    for (const p of ['/api/v1/upload', '/1/upload', '/api/v1/files', '/f/{file}', '/v/{id}', '/d/{id}/{token}']) {
      assert.ok(spec.paths[p], p);
    }
    const docs = await fetch(`${base}/docs`);
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /swagger-ui-bundle\.js/);
    assert.equal((await fetch(`${base}/docs/assets/swagger-ui-bundle.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/docs-init.js`)).status, 200);
  });
});
