import express from 'express';
import { config } from '../config.js';
import { badRequest, notFound } from '../errors.js';
import { apiKeyAuth, requireScope } from '../middleware/auth.js';
import { apiCors, enforceOrigin } from '../middleware/cors.js';
import { apiLimiter, authFailureLimiter, uploadLimiter } from '../middleware/rateLimit.js';
import * as repo from '../repo.js';
import { fileDTO, keyDTO } from '../services/serialize.js';
import { isValidId, original, removeStoredBytes, sendStored } from '../services/storage.js';
import {
  parseInteger, parseVisibility, readUploadSource, storeUpload, uploadBodyParser,
} from '../services/upload.js';

export const router = express.Router();

const PRIVATE_URL_TTL = 3600;
const smallJson = express.json({ limit: '16kb', strict: true });

router.use(apiCors, apiLimiter, authFailureLimiter, apiKeyAuth, enforceOrigin);

/** Loads a file and ensures the calling key owns it. Other keys get 404, not 403, to avoid leaking existence. */
async function ownedFile(req) {
  const { id } = req.params;
  const file = isValidId(id) ? await repo.files.findById(id) : undefined;
  if (!file || file.key_id !== req.apiKey.id) throw notFound('File not found');
  return file;
}

// ---- Upload -------------------------------------------------------------------------------------

router.post('/upload', requireScope('upload'), uploadLimiter, uploadBodyParser, async (req, res) => {
  const visibility = parseVisibility(req.body?.visibility, 'public');
  const expiration = parseInteger(req.body?.expiration, 'expiration', 60, config.maxExpirationSeconds);
  const { buffer, filename } = await readUploadSource(req);

  const { file, deleteToken } = await storeUpload({
    buffer,
    keyId: req.apiKey.id,
    title: req.body?.name || filename,
    visibility,
    expiration,
  });
  res.status(201).json({ success: true, data: fileDTO(file, { signedForSeconds: PRIVATE_URL_TTL, deleteToken }) });
});

// ---- Read ---------------------------------------------------------------------------------------

router.use(smallJson);

router.get('/me', async (req, res) => {
  res.json({ success: true, data: keyDTO(await repo.keys.findById(req.apiKey.id)) });
});

router.get('/files', requireScope('read'), async (req, res) => {
  const page = parseInteger(req.query.page, 'page', 1, 1_000_000) ?? 1;
  const limit = parseInteger(req.query.limit, 'limit', 1, 100) ?? 20;
  const kind = req.query.kind;
  if (kind !== undefined && kind !== 'image' && kind !== 'pdf') throw badRequest('kind must be "image" or "pdf"');

  const filter = { keyId: req.apiKey.id, kind: kind ?? null };
  const total = await repo.files.count(filter);
  const rows = await repo.files.list({ ...filter, limit, offset: (page - 1) * limit });
  res.json({
    success: true,
    data: rows.map((f) => fileDTO(f, { signedForSeconds: PRIVATE_URL_TTL })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

router.get('/files/:id', requireScope('read'), async (req, res) => {
  res.json({ success: true, data: fileDTO(await ownedFile(req), { signedForSeconds: PRIVATE_URL_TTL }) });
});

/** Streams the stored file to its owner, regardless of visibility. */
router.get('/files/:id/content', requireScope('read'), async (req, res, next) => {
  const file = await ownedFile(req);
  res.set({
    'Content-Type': file.mime,
    'Content-Disposition': `attachment; filename="${file.id}.${file.ext}"`,
    'Cache-Control': 'private, no-store',
  });
  await sendStored(req, res, original(file), (err) => next(err.status === 404 || err.code === 'ENOENT' ? notFound() : err));
});

router.post('/files/:id/sign', requireScope('read'), async (req, res) => {
  const file = await ownedFile(req);
  const expiresIn = parseInteger(req.body?.expires_in, 'expires_in', 60, config.maxSignedUrlSeconds) ?? PRIVATE_URL_TTL;
  res.json({ success: true, data: fileDTO(file, { signedForSeconds: expiresIn }) });
});

// ---- Update / delete ----------------------------------------------------------------------------

router.patch('/files/:id', requireScope('upload'), async (req, res) => {
  const file = await ownedFile(req);
  const visibility = parseVisibility(req.body?.visibility, undefined);
  if (!visibility) throw badRequest('Nothing to update. Supported field: visibility');
  await repo.files.setVisibility(file.id, visibility);
  res.json({ success: true, data: fileDTO(await repo.files.findById(file.id), { signedForSeconds: PRIVATE_URL_TTL }) });
});

router.delete('/files/:id', requireScope('delete'), async (req, res) => {
  const file = await ownedFile(req);
  if (await repo.files.removeWithQuota(file)) await removeStoredBytes(file);
  res.json({ success: true, data: { id: file.id, deleted: true } });
});
