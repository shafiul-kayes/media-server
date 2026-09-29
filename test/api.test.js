import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { startTestMysql } from './helpers/mysql.js';

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-server-test-'));
const mysqlServer = await startTestMysql();
Object.assign(process.env, {
  NODE_ENV: 'test',
  STORAGE_DIR: storageDir,
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef-XYZ',
  SIGNING_SECRET: 'test-signing-secret-0123456789abcdef-XYZ',
  MAX_FILE_SIZE_MB: '1',
  PUBLIC_BASE_URL: 'http://media.test',
  RATE_LIMIT_API_PER_15MIN: '10000',
  RATE_LIMIT_AUTH_FAILURES_PER_15MIN: '10000',
});

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { migrate } = await import('../src/schema.js');
const { ensureStorage } = await import('../src/services/storage.js');
const { purgeExpired } = await import('../src/cleanup.js');

let server;
let base;
let apiKey;

const ADMIN = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const localUrl = (publicUrl) => base + new URL(publicUrl).pathname + new URL(publicUrl).search;

async function uploadRaw(buffer, filename, fields = {}, key = apiKey) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', headers: { 'X-API-Key': key }, body: form });
  return { status: res.status, body: await res.json() };
}

async function createKey(body) {
  const res = await fetch(`${base}/api/v1/admin/keys`, {
    method: 'POST',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function makePdf(catalogExtra = '', extraObjects = '') {
  return Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>\nendobj\n` +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n' +
      `${extraObjects}trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
}

before(async () => {
  await migrate();
  await ensureStorage();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { body } = await createKey({ name: 'test app' });
  apiKey = body.data.key;
});

after(async () => {
  server.close();
  await closeDb();
  await mysqlServer.stop();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('authentication', () => {
  test('rejects requests without an API key', async () => {
    const res = await fetch(`${base}/api/v1/files`);
    assert.equal(res.status, 401);
  });

  test('rejects a wrong API key', async () => {
    const res = await fetch(`${base}/api/v1/files`, { headers: { 'X-API-Key': `ms_${'a'.repeat(43)}` } });
    assert.equal(res.status, 401);
  });

  test('rejects a wrong admin token', async () => {
    const res = await fetch(`${base}/api/v1/admin/keys`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
  });

  test('enforces scopes', async () => {
    const { body } = await createKey({ name: 'read only', scopes: ['read'] });
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer();
    const res = await uploadRaw(png, 'a.png', {}, body.data.key);
    assert.equal(res.status, 403);
  });

  test('disabled keys stop working', async () => {
    const { body } = await createKey({ name: 'temp' });
    await fetch(`${base}/api/v1/admin/keys/${body.data.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    const res = await fetch(`${base}/api/v1/me`, { headers: { 'X-API-Key': body.data.key } });
    assert.equal(res.status, 401);
  });
});

describe('image upload', () => {
  let uploaded;

  test('uploads a JPEG, strips EXIF metadata and serves it safely', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#f00' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-owner', ImageDescription: 'GPS here' } })
      .toBuffer();
    assert.ok((await sharp(jpeg).metadata()).exif, 'fixture should contain EXIF');

    const { status, body } = await uploadRaw(jpeg, 'holiday photo.jpg');
    assert.equal(status, 201);
    uploaded = body.data;
    assert.equal(uploaded.mime, 'image/jpeg');
    assert.equal(uploaded.width, 64);
    assert.equal(uploaded.title, 'holiday photo.jpg');

    const res = await fetch(localUrl(uploaded.url));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    const served = Buffer.from(await res.arrayBuffer());
    assert.equal((await sharp(served).metadata()).exif, undefined);
  });

  test('generates resized variants', async () => {
    const res = await fetch(localUrl(`${uploaded.url}?w=32&format=webp`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(meta.width, 32);
  });

  test('rejects invalid transform parameters', async () => {
    for (const q of ['w=0', 'w=99999', 'w=abc', 'format=svg', 'fit=evil', 'w=10&w=20']) {
      const res = await fetch(localUrl(`${uploaded.url}?${q}`));
      assert.equal(res.status, 400, q);
    }
  });

  test('lists and fetches own files only', async () => {
    const list = await (await fetch(`${base}/api/v1/files`, { headers: { 'X-API-Key': apiKey } })).json();
    assert.ok(list.data.some((f) => f.id === uploaded.id));

    const { body } = await createKey({ name: 'other' });
    const res = await fetch(`${base}/api/v1/files/${uploaded.id}`, { headers: { 'X-API-Key': body.data.key } });
    assert.equal(res.status, 404);
    const del = await fetch(`${base}/api/v1/files/${uploaded.id}`, { method: 'DELETE', headers: { 'X-API-Key': body.data.key } });
    assert.equal(del.status, 404);
  });

  test('deletes a file', async () => {
    const res = await fetch(`${base}/api/v1/files/${uploaded.id}`, { method: 'DELETE', headers: { 'X-API-Key': apiKey } });
    assert.equal(res.status, 200);
    assert.equal((await fetch(localUrl(uploaded.url))).status, 404);
  });
});

describe('malicious uploads', () => {
  test('rejects a text file disguised as PNG', async () => {
    const { status } = await uploadRaw(Buffer.from('<?php system($_GET["c"]); ?>'), 'shell.png');
    assert.equal(status, 415);
  });

  test('rejects SVG (script-capable)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { status } = await uploadRaw(Buffer.from(svg), 'x.svg');
    assert.equal(status, 415);
  });

  test('rejects HTML', async () => {
    const { status } = await uploadRaw(Buffer.from('<html><script>alert(1)</script></html>'), 'x.html');
    assert.equal(status, 415);
  });

  test('rejects a truncated/corrupt image with valid magic bytes', async () => {
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#00f' } }).png().toBuffer();
    const { status } = await uploadRaw(png.subarray(0, 60), 'broken.png');
    assert.equal(status, 422);
  });

  test('strips a payload appended to an image (polyglot)', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } }).png().toBuffer();
    const polyglot = Buffer.concat([png, Buffer.from('<script>alert(document.cookie)</script>')]);
    const { status, body } = await uploadRaw(polyglot, 'poly.png');
    assert.equal(status, 201);
    const served = Buffer.from(await (await fetch(localUrl(body.data.url))).arrayBuffer());
    assert.ok(!served.includes('<script>'));
  });

  test('rejects decompression bombs', async () => {
    const bomb = await sharp({ create: { width: 10000, height: 10000, channels: 3, background: '#000' } })
      .toColourspace('b-w')
      .png({ compressionLevel: 9 })
      .toBuffer();
    assert.ok(bomb.length < 1024 * 1024);
    const { status } = await uploadRaw(bomb, 'bomb.png');
    assert.equal(status, 422);
  });

  test('rejects files over the size limit', async () => {
    const { status } = await uploadRaw(Buffer.alloc(2 * 1024 * 1024, 1), 'big.jpg');
    assert.equal(status, 413);
  });

  test('ignores path traversal in names', async () => {
    for (const p of ['/f/..%2F..%2Fpackage.json', '/f/..%5C..%5Cpackage.json', '/f/aaaaaaaaaaaaaaaa.php']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 404, p);
    }
  });
});

describe('PDF upload', () => {
  test('accepts a clean PDF', async () => {
    const { status, body } = await uploadRaw(makePdf(), 'doc.pdf');
    assert.equal(status, 201);
    assert.equal(body.data.mime, 'application/pdf');
    assert.equal(body.data.pages, 1);
    const res = await fetch(localUrl(body.data.url));
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });

  test('rejects JavaScript', async () => {
    const { status } = await uploadRaw(makePdf('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'), 'js.pdf');
    assert.equal(status, 422);
  });

  test('rejects hex-obfuscated JavaScript names', async () => {
    const { status } = await uploadRaw(makePdf('/OpenAction << /S /J#61vaScript /J#53 (app.alert(1)) >>'), 'obf.pdf');
    assert.equal(status, 422);
  });

  test('rejects JavaScript hidden inside a compressed object stream', async () => {
    const hidden = zlib.deflateSync(Buffer.from('4 0 << /S /JavaScript /JS (app.alert(1)) >>'));
    const obj = Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${hidden.length} >>\nstream\n`),
      hidden,
      Buffer.from('\nendstream\nendobj\n'),
    ]);
    const pdf = makePdf('', obj.toString('latin1'));
    const { status } = await uploadRaw(pdf, 'objstm.pdf');
    assert.equal(status, 422);
  });

  test('rejects launch actions and embedded files', async () => {
    assert.equal((await uploadRaw(makePdf('/OpenAction << /S /Launch /F (cmd.exe) >>'), 'l.pdf')).status, 422);
    assert.equal((await uploadRaw(makePdf('/Names << /EmbeddedFiles 9 0 R >>'), 'e.pdf')).status, 422);
  });

  test('rejects encrypted PDFs', async () => {
    const pdf = Buffer.from(makePdf().toString('latin1').replace('<< /Root 1 0 R >>', '<< /Root 1 0 R /Encrypt 8 0 R >>'), 'latin1');
    assert.equal((await uploadRaw(pdf, 'enc.pdf')).status, 422);
  });
});

describe('private files', () => {
  let file;

  test('private files require a valid signature', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123' } }).png().toBuffer();
    const { status, body } = await uploadRaw(png, 'secret.png', { visibility: 'private' });
    assert.equal(status, 201);
    file = body.data;

    const plain = `${base}/f/${file.id}.${file.extension}`;
    assert.equal((await fetch(plain)).status, 404);

    const signed = await fetch(localUrl(file.url));
    assert.equal(signed.status, 200);
    assert.match(signed.headers.get('cache-control'), /^private/);

    const tampered = localUrl(file.url).replace(/sig=[^&]+/, `sig=${'A'.repeat(43)}`);
    assert.equal((await fetch(tampered)).status, 403);

    const expired = localUrl(file.url).replace(/exp=\d+/, 'exp=1000');
    assert.equal((await fetch(expired)).status, 403);
  });

  test('signed URL for one file does not unlock another', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#456' } }).png().toBuffer();
    const other = (await uploadRaw(png, 'other.png', { visibility: 'private' })).body.data;
    const sigQuery = new URL(file.url).search;
    assert.equal((await fetch(`${base}/f/${other.id}.${other.extension}${sigQuery}`)).status, 403);
  });

  test('owner can issue a new signed URL', async () => {
    const res = await fetch(`${base}/api/v1/files/${file.id}/sign`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_in: 120 }),
    });
    const { data } = await res.json();
    assert.equal((await fetch(localUrl(data.url))).status, 200);
  });
});

describe('quota and expiration', () => {
  test('enforces per-key storage quota', async () => {
    const { body } = await createKey({ name: 'tiny', quota_mb: 1 });
    const noisy = await sharp({ create: { width: 700, height: 700, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    // Two uploads each below the 1 MB size limit but together above the 1 MB quota.
    const small = await sharp(noisy).jpeg({ quality: 100 }).toBuffer();
    assert.ok(small.length < 1024 * 1024);
    let last;
    for (let i = 0; i < 6; i++) {
      last = await uploadRaw(small, `n${i}.jpg`, {}, body.data.key);
      if (last.status !== 201) break;
    }
    assert.equal(last.status, 413);
    assert.equal(last.body.error.code, 'quota_exceeded');
  });

  test('expired files are removed', async () => {
    const png = await sharp({ create: { width: 5, height: 5, channels: 3, background: '#fff' } }).png().toBuffer();
    const { body } = await uploadRaw(png, 'tmp.png', { expiration: '60' });
    assert.ok(body.data.expires_at);
    const removed = await purgeExpired(Date.now() + 61_000);
    assert.ok(removed >= 1);
    assert.equal((await fetch(localUrl(body.data.url))).status, 404);
  });
});
