import sharp from 'sharp';
import { config } from '../config.js';
import { HttpError, badRequest } from '../errors.js';
import { countVariants, findVariant, readOriginal, saveVariant } from './storage.js';

sharp.cache({ memory: 64, files: 0 });

const decodeOptions = (extra = {}) => ({
  limitInputPixels: config.maxImagePixels, // decompression-bomb guard
  failOn: 'error',
  ...extra,
});

function encode(pipeline, ext) {
  switch (ext) {
    case 'jpg': return pipeline.jpeg({ quality: 90, mozjpeg: true });
    case 'png': return pipeline.png({ compressionLevel: 8 });
    case 'webp': return pipeline.webp({ quality: 90 });
    case 'gif': return pipeline.gif();
    case 'avif': return pipeline.avif({ quality: 60 });
    default: throw new Error(`Unsupported output format: ${ext}`);
  }
}

/**
 * Fully decodes and re-encodes an uploaded image. This validates that it really is a
 * well-formed image, applies EXIF orientation and strips all metadata (GPS, camera info,
 * embedded thumbnails) as well as any payload appended to the file (polyglots).
 */
export async function processImage(buffer, type) {
  let meta;
  try {
    meta = await sharp(buffer, decodeOptions()).metadata();
  } catch {
    throw new HttpError(422, 'invalid_image', 'Image is corrupted or too large');
  }
  const pages = meta.pages || 1;
  const frameHeight = meta.pageHeight || meta.height;
  if (!meta.width || !frameHeight) throw new HttpError(422, 'invalid_image', 'Image has no dimensions');
  if (pages > config.maxAnimationFrames) throw new HttpError(422, 'invalid_image', 'Animation has too many frames');
  if (meta.width * frameHeight * pages > config.maxImagePixels) {
    throw new HttpError(422, 'invalid_image', 'Image dimensions are too large');
  }

  const animated = pages > 1 && (type.ext === 'gif' || type.ext === 'webp');
  let pipeline = sharp(buffer, decodeOptions({ animated }));
  if (!animated) pipeline = pipeline.rotate();

  try {
    const { data, info } = await encode(pipeline, type.ext).toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.pageHeight || info.height };
  } catch {
    throw new HttpError(422, 'invalid_image', 'Image could not be processed');
  }
}

const OUTPUT_FORMATS = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
const FITS = ['cover', 'contain', 'fill', 'inside', 'outside'];
const TRANSFORM_KEYS = ['w', 'h', 'fit', 'format', 'q'];

function readParam(query, key) {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`Invalid "${key}" parameter`);
  return value;
}

function intParam(query, key, min, max) {
  const value = readParam(query, key);
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/.test(value)) throw badRequest(`"${key}" must be an integer`);
  const n = Number(value);
  if (n < min || n > max) throw badRequest(`"${key}" must be between ${min} and ${max}`);
  return n;
}

export const hasTransform = (query) => TRANSFORM_KEYS.some((k) => query[k] !== undefined);

/** Parses on-the-fly transform params (?w=&h=&fit=&format=&q=). Returns null if none are present. */
export function parseTransform(query, originalExt) {
  if (!hasTransform(query)) return null;
  const max = config.maxTransformDimension;
  const w = intParam(query, 'w', 1, max);
  const h = intParam(query, 'h', 1, max);
  const q = intParam(query, 'q', 1, 100) ?? 80;
  const fit = readParam(query, 'fit') ?? 'cover';
  if (!FITS.includes(fit)) throw badRequest(`"fit" must be one of: ${FITS.join(', ')}`);
  const formatParam = readParam(query, 'format');
  const format = formatParam === undefined ? (originalExt === 'gif' ? 'png' : originalExt) : OUTPUT_FORMATS[formatParam];
  if (!format) throw badRequest(`"format" must be one of: ${Object.keys(OUTPUT_FORMATS).join(', ')}`);
  return { w, h, fit, format, q };
}

/** Cache key for a transform. Composed only of validated numbers and whitelisted words. */
export const variantName = (t) => `${t.w ?? 0}x${t.h ?? 0}-${t.fit}-q${t.q}.${t.format}`;

/**
 * Returns a servable handle to the requested variant, generating and caching it on first use
 * (in MySQL or on disk, wherever the original lives).
 */
export async function getVariant(file, t, mime) {
  const name = variantName(t);
  const cached = await findVariant(file, name);
  if (cached) return cached;

  if ((await countVariants(file)) >= config.maxVariantsPerFile) {
    throw new HttpError(429, 'too_many_variants', 'Variant limit reached for this file; reuse an existing size');
  }

  const source = await readOriginal(file);
  const pipeline = sharp(source, decodeOptions()).resize({
    width: t.w,
    height: t.h,
    fit: t.fit,
    withoutEnlargement: true,
  });
  const output = await encode(pipeline, t.format).toBuffer();
  return saveVariant(file, name, mime, output);
}
