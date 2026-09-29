import { config } from '../config.js';

/**
 * True when `origin` (scheme://host[:port]) is this site: either PUBLIC_BASE_URL, or the host the
 * browser actually sent the request to. The scheme is ignored for the Host comparison because TLS
 * usually ends at a proxy/CDN (Hostinger, Cloudflare), so the app itself may only see http.
 * A cross-site request still fails: its Origin names the attacker's host, not ours.
 */
export function isOwnOrigin(req, origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin === new URL(config.baseUrl).origin) return true;
  const host = req.get('host');
  return Boolean(host) && url.host.toLowerCase() === host.toLowerCase();
}
