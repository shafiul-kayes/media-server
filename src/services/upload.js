import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { HttpError, badRequest } from '../errors.js';
import * as repo from '../repo.js';
import { detectType } from './fileType.js';
import { processImage } from './image.js';
import { inspectPdf } from './pdf.js';
import { fetchRemote } from './remote.js';
import { newId, removeStoredBytes, saveToDisk } from './storage.js';

// A base64 string is ~4/3 the size of the file it encodes.
const BASE64_LIMIT = Math.ceil((config.maxFileSize * 4) / 3) + 1024;

/**
 * Body parsers for upload endpoints. Accepts, like imgbb:
 *  - multipart/form-data with a binary `file` or `image` part, or `image` as a base64/URL text field
 *  - application/x-www-form-urlencoded or JSON with `image` as base64, a data: URI or an http(s) URL
 */
export const uploadBodyParser = [
  multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8', // decode non-ASCII filenames correctly
    limits: {
      fileSize: config.maxFileSize,
      files: 1,
      fields: 8,
      fieldNameSize: 50,
      fieldSize: BASE64_LIMIT,
      parts: 9,
      headerPairs: 50,
    },
  }).fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  express.urlencoded({ extended: false, limit: BASE64_LIMIT + 4096, parameterLimit: 10 }),
  express.json({ limit: BASE64_LIMIT + 4096 }),
];

export function sanitizeTitle(value) {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '') // control & bidi chars
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned || 'untitled';
}

export function parseVisibility(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value !== 'public' && value !== 'private') throw badRequest('visibility must be "public" or "private"');
  return value;
}

export function parseInteger(value, name, min, max) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function decodeBase64(value) {
  const payload = value.replace(/^data:[\w.+/-]+;base64,/i, '').replace(/\s+/g, '');
  if (!payload || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) {
    throw badRequest('"image" must be a file, a base64 string, a data: URI or an http(s) URL');
  }
  if (Math.floor((payload.length * 3) / 4) > config.maxFileSize) {
    throw new HttpError(413, 'file_too_large', `File exceeds the ${Math.round(config.maxFileSize / 1048576)} MB limit`);
  }
  return Buffer.from(payload, 'base64');
}

/** Resolves the uploaded bytes from a multipart file, a base64 string or a remote URL. */
export async function readUploadSource(req) {
  const part = req.files?.file?.[0] ?? req.files?.image?.[0];
  if (part) return { buffer: part.buffer, filename: part.originalname, source: 'file' };

  const value = req.body?.image ?? req.body?.file ?? req.body?.url;
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('No image provided. Send "image" (or "file") as a file, base64 string or URL', 'missing_image');
  }
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const { buffer, filename } = await fetchRemote(trimmed);
    return { buffer, filename, source: 'url' };
  }
  return { buffer: decodeBase64(trimmed), filename: 'upload', source: 'base64' };
}

/**
 * Validates, sanitises and stores an upload for the given key. Returns the stored file row and
 * the one-time plaintext delete token (only its hash is persisted).
 */
export async function storeUpload({ buffer, keyId, title, visibility = 'public', expiration }) {
  const type = await detectType(buffer);
  if (!type) {
    throw new HttpError(415, 'unsupported_type', 'Only JPEG, PNG, WebP, GIF, AVIF images and PDF documents are allowed');
  }

  let width = null;
  let height = null;
  let pages = null;
  if (type.kind === 'image') {
    ({ buffer, width, height } = await processImage(buffer, type));
  } else {
    ({ pages } = inspectPdf(buffer));
  }

  const key = await repo.keys.findById(keyId);
  if (key.used_bytes + buffer.length > key.quota_bytes) {
    throw new HttpError(413, 'quota_exceeded', 'Storage quota exceeded for this API key');
  }

  const deleteToken = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const row = {
    id: newId(),
    keyId,
    kind: type.kind,
    mime: type.mime,
    ext: type.ext,
    size: buffer.length,
    width,
    height,
    pages,
    originalName: sanitizeTitle(title),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    visibility,
    storage: config.storageDriver,
    createdAt: now,
    expiresAt: expiration ? now + expiration * 1000 : null,
    deleteTokenHash: crypto.createHash('sha256').update(deleteToken).digest('hex'),
  };

  // MySQL: row, bytes and quota are written in one transaction.
  // Disk: the file is written first and removed again if the database insert fails.
  const inMysql = row.storage === 'mysql';
  if (!inMysql) await saveToDisk(row.id, row.ext, buffer);
  let stored = false;
  try {
    stored = await repo.files.insertWithQuota(row, inMysql ? buffer : null);
  } finally {
    if (!stored && !inMysql) await removeStoredBytes({ ...row, storage: 'disk' });
  }
  if (!stored) throw new HttpError(413, 'quota_exceeded', 'Storage quota exceeded for this API key');

  return { file: await repo.files.findById(row.id), deleteToken };
}

/** Constant-time check of a delete token against the stored hash. */
export function deleteTokenMatches(file, token) {
  if (!file?.delete_token_hash || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return false;
  const given = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(given, Buffer.from(file.delete_token_hash, 'hex'));
}
