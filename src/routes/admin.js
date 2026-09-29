import express from 'express';
import { HttpError, badRequest } from '../errors.js';
import { adminAuth } from '../middleware/auth.js';
import { adminLimiter, authFailureLimiter } from '../middleware/rateLimit.js';
import * as repo from '../repo.js';
import { createApiKey, parseName, parseQuotaMb, parseScopes } from '../services/apiKeys.js';
import { parseOrigins } from '../services/origins.js';
import { keyDTO } from '../services/serialize.js';
import { removeStoredBytes } from '../services/storage.js';

export const router = express.Router();

router.use(adminLimiter, authFailureLimiter, adminAuth);

const findKey = async (id) => {
  const key = typeof id === 'string' && id.length < 64 ? await repo.keys.findById(id) : undefined;
  if (!key) throw new HttpError(404, 'not_found', 'API key not found');
  return key;
};

router.post('/keys', async (req, res) => {
  const body = req.body ?? {};
  const { secret, key } = await createApiKey({
    name: parseName(body.name),
    scopes: parseScopes(body.scopes),
    quotaBytes: parseQuotaMb(body.quota_mb),
    allowedOrigins: parseOrigins(body.allowed_origins) ?? [],
  });
  res.status(201).json({
    success: true,
    data: { ...keyDTO(key), key: secret },
    warning: 'Store this key now. It cannot be retrieved again.',
  });
});

router.get('/keys', async (req, res) => {
  res.json({ success: true, data: (await repo.keys.list()).map(keyDTO) });
});

router.patch('/keys/:id', async (req, res) => {
  const key = await findKey(req.params.id);
  const body = req.body ?? {};
  if (body.active !== undefined && typeof body.active !== 'boolean') throw badRequest('active must be a boolean');
  await repo.keys.update(key.id, {
    name: body.name === undefined ? undefined : parseName(body.name),
    scopes: body.scopes === undefined ? undefined : parseScopes(body.scopes).join(','),
    quota_bytes: body.quota_mb === undefined ? undefined : parseQuotaMb(body.quota_mb),
    active: body.active === undefined ? undefined : Number(body.active),
    allowed_origins: parseOrigins(body.allowed_origins)?.join(','),
  });
  res.json({ success: true, data: keyDTO(await repo.keys.findById(key.id)) });
});

/** Permanently deletes the key and every file it uploaded. To merely block a key, PATCH active=false. */
router.delete('/keys/:id', async (req, res) => {
  const key = await findKey(req.params.id);
  const owned = await repo.keys.remove(key.id);
  for (const f of owned) await removeStoredBytes(f);
  res.json({ success: true, data: { id: key.id, deleted: true, files_deleted: owned.length } });
});

router.get('/stats', async (req, res) => {
  res.json({ success: true, data: await repo.stats() });
});
