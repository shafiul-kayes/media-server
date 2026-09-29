import { config } from '../config.js';
import { splitOrigins } from './origins.js';
import { signParams } from './signer.js';

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** Direct file URL with optional transform params; private files get a signature. */
function makeUrlBuilder(file, signedForSeconds) {
  const direct = `${config.baseUrl}/f/${file.id}.${file.ext}`;
  const auth = signedForSeconds ? signParams(file.id, signedForSeconds) : null;
  const build = (params = {}) => {
    const query = new URLSearchParams({ ...(auth ? { exp: String(auth.exp), sig: auth.sig } : {}), ...params });
    const qs = query.toString();
    return qs ? `${direct}?${qs}` : direct;
  };
  build.expiresAt = auth ? new Date(auth.exp * 1000).toISOString() : null;
  return build;
}

export const viewerUrl = (file) => `${config.baseUrl}/v/${file.id}`;
export const deleteUrl = (file, token) => `${config.baseUrl}/d/${file.id}/${token}`;

const THUMB = { w: '320', h: '320', fit: 'cover', format: 'webp' };

/**
 * Public representation of a file. Private files get short-lived signed URLs when
 * `signedForSeconds` is given; otherwise their plain URL (which will not work without a signature).
 * `deleteToken` is only known right after upload.
 */
export function fileDTO(file, { signedForSeconds = 0, deleteToken } = {}) {
  const isPrivate = file.visibility === 'private';
  const url = makeUrlBuilder(file, isPrivate ? signedForSeconds : 0);
  return {
    id: file.id,
    title: file.original_name,
    kind: file.kind,
    mime: file.mime,
    extension: file.ext,
    size: file.size,
    width: file.width,
    height: file.height,
    pages: file.pages,
    sha256: file.sha256,
    visibility: file.visibility,
    url: url(),
    thumb_url: file.kind === 'image' ? url(THUMB) : null,
    download_url: url({ download: '1' }),
    viewer_url: isPrivate ? null : viewerUrl(file),
    ...(deleteToken ? { delete_url: deleteUrl(file, deleteToken) } : {}),
    ...(url.expiresAt ? { signed_url_expires_at: url.expiresAt } : {}),
    created_at: iso(file.created_at),
    expires_at: iso(file.expires_at),
  };
}

/** Response body in the same shape as https://api.imgbb.com/1/upload (values are strings, like imgbb). */
export function imgbbDTO(file, { deleteToken, signedForSeconds = 0 } = {}) {
  const url = makeUrlBuilder(file, file.visibility === 'private' ? signedForSeconds : 0);
  const name = file.original_name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || file.id;
  const entry = (href) => ({ filename: `${name}.${file.ext}`, name, mime: file.mime, extension: file.ext, url: href });
  const isImage = file.kind === 'image';
  const hasMedium = isImage && file.width > 640;
  const mediumUrl = url({ w: '640', fit: 'inside' });

  return {
    id: file.id,
    title: name,
    url_viewer: file.visibility === 'private' ? null : viewerUrl(file),
    url: url(),
    display_url: hasMedium ? mediumUrl : url(),
    width: String(file.width ?? 0),
    height: String(file.height ?? 0),
    size: String(file.size),
    time: String(Math.floor(file.created_at / 1000)),
    expiration: String(file.expires_at ? Math.round((file.expires_at - file.created_at) / 1000) : 0),
    image: entry(url()),
    ...(isImage ? { thumb: entry(url({ w: '180', h: '180', fit: 'cover' })) } : {}),
    ...(hasMedium ? { medium: entry(mediumUrl) } : {}),
    ...(deleteToken ? { delete_url: deleteUrl(file, deleteToken) } : {}),
  };
}

export function keyDTO(key) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes.split(','),
    allowed_origins: splitOrigins(key.allowed_origins),
    quota_bytes: key.quota_bytes,
    used_bytes: key.used_bytes,
    active: Boolean(key.active),
    created_at: iso(key.created_at),
    last_used_at: iso(key.last_used_at),
  };
}
