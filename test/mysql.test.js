import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { startTestMysql } from './helpers/mysql.js';

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-server-mysql-'));
const mysqlServer = await startTestMysql();
Object.assign(process.env, {
  NODE_ENV: 'test',
  STORAGE_DRIVER: 'mysql',
  STORAGE_DIR: storageDir,
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef-XYZ',
  SIGNING_SECRET: 'test-signing-secret-0123456789abcdef-XYZ',
  PUBLIC_BASE_URL: 'http://media.test',
  RATE_LIMIT_API_PER_15MIN: '10000',
  RATE_LIMIT_AUTH_FAILURES_PER_15MIN: '10000',
});

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { closeDb, pool } = await import('../src/db.js');
const { migrate } = await import('../src/schema.js');
const repo = await import('../src/repo.js');

let server;
let base;
let apiKey;
let png;

const ADMIN = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const local = (publicUrl) => {
  const u = new URL(publicUrl);
  return base + u.pathname + u.search;
};
const count = async (sql, params = []) => Number((await pool.query(sql, params))[0][0].n);

async function createKey(body) {
  const res = await fetch(`${base}/api/v1/admin/keys`, {
    method: 'POST',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()).data;
}

async function upload(buffer, fields = {}, key = apiKey) {
  const form = new FormData();
  form.append('image', new Blob([buffer]), fields.filename ?? 'img.png');
  for (const [k, v] of Object.entries(fields)) if (k !== 'filename') form.append(k, v);
  const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', headers: { 'X-API-Key': key }, body: form });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  await migrate();
  png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#e91e63' } }).png().toBuffer();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  apiKey = (await createKey({ name: 'mysql tests' })).key;
});

after(async () => {
  server.close();
  await closeDb();
  await mysqlServer.stop();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('schema', () => {
  test('creates all tables with InnoDB and utf8mb4', async () => {
    const [rows] = await pool.query(
      `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const names = rows.map((r) => r.name).sort();
    assert.deepEqual(names, ['api_keys', 'file_blobs', 'file_variants', 'files', 'schema_migrations']);
    for (const r of rows) {
      assert.equal(r.engine, 'InnoDB', r.name);
      assert.match(r.collation, /^utf8mb4/, r.name);
    }
  });

  test('migrations are idempotent', async () => {
    assert.deepEqual(await migrate(), []);
  });
});

describe('MySQL storage driver', () => {
  let file;

  test('stores the bytes in file_blobs, not on disk', async () => {
    const { status, body } = await upload(png);
    assert.equal(status, 201);
    file = body.data;
    const [[row]] = await pool.query('SELECT f.storage, LENGTH(b.data) AS len FROM files f JOIN file_blobs b ON b.file_id = f.id WHERE f.id = ?', [file.id]);
    assert.equal(row.storage, 'mysql');
    assert.equal(row.len, file.size);
    assert.equal(fs.existsSync(path.join(storageDir, 'files')), false);
  });

  test('serves the stored bytes with ETag, 304 and Range support', async () => {
    const res = await fetch(local(file.url));
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.length, file.size);
    const etag = res.headers.get('etag');
    assert.ok(etag);

    // fetch() adds `Cache-Control: no-cache` to conditional requests unless one is given.
    const cached = await fetch(local(file.url), { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
    assert.equal(cached.status, 304);

    const partial = await fetch(local(file.url), { headers: { Range: 'bytes=0-9' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-9/${file.size}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 10));

    const bad = await fetch(local(file.url), { headers: { Range: `bytes=${file.size + 10}-` } });
    assert.equal(bad.status, 416);
  });

  test('stores generated variants in file_variants and reuses them', async () => {
    const first = await fetch(local(`${file.url}?w=100&format=webp`));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/webp');
    assert.equal(await count('SELECT COUNT(*) AS n FROM file_variants WHERE file_id = ?', [file.id]), 1);
    const second = await fetch(local(`${file.url}?w=100&format=webp`));
    assert.equal(second.status, 200);
    assert.equal(await count('SELECT COUNT(*) AS n FROM file_variants WHERE file_id = ?', [file.id]), 1);
  });

  test('deleting a file cascades to its blob and variants and refunds quota', async () => {
    const before = (await repo.keys.findByHash((await import('../src/services/apiKeys.js')).hashKey(apiKey))).used_bytes;
    const res = await fetch(`${base}/api/v1/files/${file.id}`, { method: 'DELETE', headers: { 'X-API-Key': apiKey } });
    assert.equal(res.status, 200);
    assert.equal(await count('SELECT COUNT(*) AS n FROM file_blobs WHERE file_id = ?', [file.id]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM file_variants WHERE file_id = ?', [file.id]), 0);
    const afterBytes = (await repo.keys.findByHash((await import('../src/services/apiKeys.js')).hashKey(apiKey))).used_bytes;
    assert.equal(before - afterBytes, file.size);
  });

  test('stores PDFs in MySQL too', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const { status, body } = await upload(pdf, { filename: 'doc.pdf' });
    assert.equal(status, 201);
    const served = await fetch(local(body.data.url));
    assert.equal(served.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), pdf);
  });
});

describe('data integrity and safety', () => {
  test('file ids are case-sensitive', async () => {
    const { body } = await upload(png);
    const id = body.data.id;
    const swapped = [...id].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
    if (swapped !== id) assert.equal(await repo.files.findById(swapped), undefined);
    assert.ok(await repo.files.findById(id));
  });

  test('SQL injection in user input is stored as plain text', async () => {
    const evil = "x'); DROP TABLE files; --";
    const { status, body } = await upload(png, { name: evil });
    assert.equal(status, 201);
    assert.equal(body.data.title, evil);
    assert.equal(await count("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'files'"), 1);
    const list = await fetch(`${base}/api/v1/files?kind=image' OR '1'='1`, { headers: { 'X-API-Key': apiKey } });
    assert.equal(list.status, 400);
  });

  test('Bengali and emoji titles round-trip (utf8mb4)', async () => {
    const title = 'বাংলা ছবি 📷.png';
    const { body } = await upload(png, { name: title });
    const res = await fetch(`${base}/api/v1/files/${body.data.id}`, { headers: { 'X-API-Key': apiKey } });
    assert.equal((await res.json()).data.title, title);
  });

  test('concurrent uploads never exceed the quota', async () => {
    const key = await createKey({ name: 'quota race', quota_mb: 1 });
    const noisy = await sharp({ create: { width: 500, height: 500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const results = await Promise.all(Array.from({ length: 10 }, () => upload(noisy, { filename: 'n.jpg' }, key.key)));
    const accepted = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 413);
    assert.equal(accepted.length + rejected.length, 10);
    assert.ok(rejected.length > 0, 'some uploads must be rejected');
    const stored = accepted.reduce((sum, r) => sum + r.body.data.size, 0);
    const row = await repo.keys.findById(key.id);
    assert.equal(row.used_bytes, stored);
    assert.ok(row.used_bytes <= row.quota_bytes);
  });
});

describe('switching STORAGE_DRIVER', () => {
  let diskFile;

  test('disk driver writes files to STORAGE_DIR, not MySQL', async () => {
    config.storageDriver = 'disk';
    try {
      const { status, body } = await upload(png);
      assert.equal(status, 201);
      diskFile = body.data;
    } finally {
      config.storageDriver = 'mysql';
    }
    assert.equal(await count('SELECT COUNT(*) AS n FROM file_blobs WHERE file_id = ?', [diskFile.id]), 0);
    assert.ok(fs.existsSync(path.join(storageDir, 'files', diskFile.id.slice(0, 2), `${diskFile.id}.png`)));
  });

  test('files from both drivers stay readable after switching back', async () => {
    const res = await fetch(local(diskFile.url));
    assert.equal(res.status, 200);
    const variant = await fetch(local(`${diskFile.url}?w=50`));
    assert.equal(variant.status, 200);
    assert.equal((await repo.stats()).files_on_disk, 1);
  });

  test('deleting a disk file removes it from disk', async () => {
    const res = await fetch(`${base}/api/v1/files/${diskFile.id}`, { method: 'DELETE', headers: { 'X-API-Key': apiKey } });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(storageDir, 'files', diskFile.id.slice(0, 2), `${diskFile.id}.png`)), false);
    assert.equal(fs.existsSync(path.join(storageDir, 'variants', diskFile.id.slice(0, 2), diskFile.id)), false);
  });
});

describe('admin', () => {
  test('stats and key deletion purge everything', async () => {
    const key = await createKey({ name: 'to delete' });
    await upload(png, {}, key.key);
    await upload(png, {}, key.key);
    const stats = await (await fetch(`${base}/api/v1/admin/stats`, { headers: ADMIN })).json();
    assert.ok(stats.data.files >= 2);
    const res = await fetch(`${base}/api/v1/admin/keys/${key.id}`, { method: 'DELETE', headers: ADMIN });
    assert.equal((await res.json()).data.files_deleted, 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM files WHERE key_id = ?', [key.id]), 0);
  });
});
