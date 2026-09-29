import express from 'express';
import { config } from '../config.js';
import { HttpError, notFound } from '../errors.js';
import { publicLimiter, transformLimiter } from '../middleware/rateLimit.js';
import * as repo from '../repo.js';
import { MIME_BY_EXT } from '../services/fileType.js';
import { getVariant, hasTransform, parseTransform } from '../services/image.js';
import { verifySignature } from '../services/signer.js';
import { original, sendStored } from '../services/storage.js';

export const router = express.Router();

const NAME_RE = /^([A-Za-z0-9_-]{16})\.(jpg|png|webp|gif|avif|pdf)$/;
// 'self' lets the /v/ viewer page embed PDFs even when FRAME_ANCESTORS is restricted.
const frameAncestors = config.frameAncestors.includes('*') ? '*' : ["'self'", ...config.frameAncestors].join(' ');

// Images are rendered as inert documents even if opened directly: no scripts, no plugins.
const IMAGE_CSP = `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors ${frameAncestors}`;
// Browser PDF viewers refuse to run under a CSP sandbox; active content is blocked at upload instead.
const PDF_CSP = `default-src 'none'; frame-ancestors ${frameAncestors}`;

function contentDisposition(file, ext, download) {
  const base = file.original_name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const name = `${base}.${ext}`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

router.use(publicLimiter);

const limitTransforms = (req, res, next) => (hasTransform(req.query) ? transformLimiter(req, res, next) : next());

router.get('/:name', limitTransforms, async (req, res, next) => {
  const match = NAME_RE.exec(req.params.name);
  if (!match) throw notFound();
  const [, id, ext] = match;

  const file = await repo.files.findById(id);
  if (!file || file.ext !== ext || (file.expires_at && file.expires_at <= Date.now())) throw notFound();

  const { exp, sig } = req.query;
  if (file.visibility === 'private') {
    if (sig === undefined) throw notFound();
    if (!verifySignature(file.id, exp, sig)) throw new HttpError(403, 'invalid_signature', 'Invalid or expired signature');
  }

  let handle;
  let mime = file.mime;
  let outExt = file.ext;

  const transform = file.kind === 'image' ? parseTransform(req.query, file.ext) : null;
  if (transform) {
    outExt = transform.format;
    mime = MIME_BY_EXT[outExt];
    handle = await getVariant(file, transform, mime);
  } else {
    handle = original(file);
  }

  const maxAge = file.visibility === 'public'
    ? 'public, max-age=31536000, immutable'
    : `private, max-age=${Math.max(0, Math.min(3600, Number(exp) - Math.floor(Date.now() / 1000)))}`;

  res.set({
    'Content-Type': mime,
    'Content-Disposition': contentDisposition(file, outExt, req.query.download === '1'),
    'Content-Security-Policy': file.kind === 'pdf' ? PDF_CSP : IMAGE_CSP,
    'Cache-Control': file.expires_at ? 'private, no-cache' : maxAge,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': file.visibility === 'private' ? 'noindex, nofollow' : 'all',
  });
  if (file.visibility === 'public') res.set('Access-Control-Allow-Origin', '*');
  res.removeHeader('X-Frame-Options'); // embedding is governed by the CSP frame-ancestors above

  await sendStored(req, res, handle, (err) => next(err.status === 404 || err.code === 'ENOENT' ? notFound() : err));
});
