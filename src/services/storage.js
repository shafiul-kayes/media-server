import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as repo from '../repo.js';

/**
 * Uploaded bytes live either in MySQL (file_blobs / file_variants tables) or on disk under
 * STORAGE_DIR. Each file row records its own `storage`, so both can coexist after switching
 * STORAGE_DRIVER. Everything else in the app goes through this module.
 */

const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const EXT_RE = /^(jpg|png|webp|gif|avif|pdf)$/;

/** 96-bit random, URL-safe, unguessable id. */
export const newId = () => crypto.randomBytes(12).toString('base64url');
export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

// ---- Disk backend -------------------------------------------------------------------------------

function assertSafe(id, ext) {
  // Ids and extensions only ever come from our own generator/whitelist, but check anyway so a
  // bug elsewhere can never turn into path traversal.
  if (!isValidId(id) || (ext !== undefined && !EXT_RE.test(ext))) throw new Error('Unsafe storage path');
}

const filesRoot = () => path.join(config.storageDir, 'files');
const variantsRoot = () => path.join(config.storageDir, 'variants');

function diskPath(id, ext) {
  assertSafe(id, ext);
  return path.join(filesRoot(), id.slice(0, 2), `${id}.${ext}`);
}

function diskVariantDir(id) {
  assertSafe(id);
  return path.join(variantsRoot(), id.slice(0, 2), id);
}

export async function ensureStorage() {
  if (config.storageDriver !== 'disk') return;
  await fs.mkdir(filesRoot(), { recursive: true, mode: 0o700 });
  await fs.mkdir(variantsRoot(), { recursive: true, mode: 0o700 });
}

/** Writes via a temp file + rename so readers never see a partially written file. */
async function writeAtomic(target, buffer) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, buffer, { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export const saveToDisk = (id, ext, buffer) => writeAtomic(diskPath(id, ext), buffer);

// ---- Backend-independent API ------------------------------------------------------------------

/** Removes bytes that live outside the database. MySQL blobs are removed by ON DELETE CASCADE. */
export async function removeStoredBytes(file) {
  if (file.storage !== 'disk') return;
  await fs.rm(diskPath(file.id, file.ext), { force: true });
  await fs.rm(diskVariantDir(file.id), { recursive: true, force: true });
}

export async function readOriginal(file) {
  const data = file.storage === 'disk' ? await fs.readFile(diskPath(file.id, file.ext)) : await repo.blobs.read(file.id);
  if (!data) throw Object.assign(new Error('Stored bytes missing'), { status: 404 });
  return data;
}

/** A servable handle to the original bytes. */
export function original(file) {
  return file.storage === 'disk'
    ? { path: diskPath(file.id, file.ext) }
    : { load: () => readOriginal(file), etag: `"${file.sha256.slice(0, 40)}"`, lastModified: file.created_at };
}

/** A servable handle to a cached variant, or undefined if it has not been generated yet. */
export async function findVariant(file, name) {
  if (file.storage === 'disk') {
    const target = path.join(diskVariantDir(file.id), name);
    try {
      await fs.access(target);
      return { path: target };
    } catch {
      return undefined;
    }
  }
  const row = await repo.blobs.readVariant(file.id, name);
  return row && { data: row.data, etag: `"${file.sha256.slice(0, 24)}-${name}"`, lastModified: row.createdAt };
}

export async function countVariants(file) {
  if (file.storage !== 'disk') return repo.blobs.countVariants(file.id);
  const entries = await fs.readdir(diskVariantDir(file.id)).catch(() => []);
  return entries.filter((f) => !f.endsWith('.tmp')).length;
}

/** Stores a generated variant and returns a servable handle to it. */
export async function saveVariant(file, name, mime, data) {
  if (file.storage === 'disk') {
    const target = path.join(diskVariantDir(file.id), name);
    await writeAtomic(target, data);
    return { path: target };
  }
  await repo.blobs.writeVariant(file.id, name, mime, data);
  return { data, etag: `"${file.sha256.slice(0, 24)}-${name}"`, lastModified: Date.now() };
}

/** Sends an in-memory body with ETag / 304 and single-range (206) support, like res.sendFile does. */
function sendBuffer(req, res, data, { etag, lastModified }) {
  res.set({ ETag: etag, 'Last-Modified': new Date(lastModified).toUTCString(), 'Accept-Ranges': 'bytes' });
  if (req.fresh) return res.status(304).end();

  const ifRange = req.get('if-range');
  const ranges = !ifRange || ifRange === etag ? req.range(data.length, { combine: true }) : undefined;
  if (ranges === -1) return res.status(416).set('Content-Range', `bytes */${data.length}`).end();
  if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
    const { start, end } = ranges[0];
    return res.status(206).set('Content-Range', `bytes ${start}-${end}/${data.length}`).send(data.subarray(start, end + 1));
  }
  res.send(data);
}

/**
 * Sends a handle from `original` / `findVariant` / `saveVariant`. Headers such as Content-Type
 * must already be set. Errors are passed to `next`.
 */
export async function sendStored(req, res, handle, next) {
  if (handle.path) {
    // Resolve against the storage root so send's dotfile check only sees our generated sub-path.
    const relative = path.relative(config.storageDir, handle.path);
    return res.sendFile(relative, { root: config.storageDir, dotfiles: 'deny', cacheControl: false }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  }
  try {
    const data = handle.data ?? (await handle.load());
    sendBuffer(req, res, data, handle);
  } catch (err) {
    next(err);
  }
}
