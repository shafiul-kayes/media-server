import http from 'node:http';
import express from 'express';
import { config } from '../config.js';
import { apiKeyAuthFrom, readKey, authenticate, requireScope } from '../middleware/auth.js';
import { apiCors, enforceOrigin } from '../middleware/cors.js';
import { apiLimiter, authFailureLimiter, uploadLimiter } from '../middleware/rateLimit.js';
import { imgbbDTO } from '../services/serialize.js';
import { parseInteger, parseVisibility, readUploadSource, storeUpload, uploadBodyParser } from '../services/upload.js';
import { errorHandler } from '../middleware/errors.js';

/**
 * imgbb-compatible API: POST /1/upload?key=KEY with `image` (file, base64 or URL), optional
 * `name` and `expiration`. Responses mirror imgbb's shape so existing clients work unchanged.
 */
export const router = express.Router();

router.use(apiCors, apiLimiter, authFailureLimiter);

// Authenticate before reading the body whenever the key is in a header or the query string,
// so unauthenticated clients cannot make us buffer large bodies.
const earlyAuth = async (req, res, next) => {
  const raw = readKey(req, { query: true });
  if (raw) req.apiKey = await authenticate(raw);
  next();
};

router.post(
  '/upload',
  earlyAuth,
  uploadBodyParser,
  apiKeyAuthFrom({ query: true, body: true }),
  enforceOrigin,
  requireScope('upload'),
  uploadLimiter,
  async (req, res) => {
    const { buffer, filename } = await readUploadSource(req);
    const { file, deleteToken } = await storeUpload({
      buffer,
      keyId: req.apiKey.id,
      title: req.body?.name || filename,
      visibility: parseVisibility(req.body?.visibility, 'public'),
      expiration: parseInteger(req.query.expiration ?? req.body?.expiration, 'expiration', 60, config.maxExpirationSeconds),
    });
    res.status(200).json({ data: imgbbDTO(file, { deleteToken, signedForSeconds: 3600 }), success: true, status: 200 });
  },
);

/** Errors in imgbb's format: { status_code, error: { message, code }, status_txt }. */
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  // Reuse the main handler's classification, then reshape its JSON.
  const json = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    return json({
      status_code: status,
      success: false,
      error: { message: body.error.message, code: body.error.code },
      status_txt: http.STATUS_CODES[status] ?? 'Error',
    });
  };
  errorHandler(err, req, res, next);
});
