import { fileTypeFromBuffer } from 'file-type';

/**
 * Whitelist of accepted types. SVG, HTML, HEIC, TIFF etc. are deliberately excluded:
 * SVG can carry scripts, and anything not listed here is rejected.
 */
export const ALLOWED_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/avif': { ext: 'avif', kind: 'image' },
  'application/pdf': { ext: 'pdf', kind: 'pdf' },
};

export const MIME_BY_EXT = Object.fromEntries(Object.entries(ALLOWED_TYPES).map(([mime, t]) => [t.ext, mime]));

/**
 * Detects the real type from the file's magic bytes. The client-supplied filename and
 * Content-Type are never trusted.
 */
export async function detectType(buffer) {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_TYPES[detected.mime]) return null;
  return { mime: detected.mime, ...ALLOWED_TYPES[detected.mime] };
}
