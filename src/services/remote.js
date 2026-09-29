import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

// Private, loopback, link-local (cloud metadata), CGNAT, multicast, documentation and other
// special-purpose ranges. Remote uploads may never reach these (SSRF protection).
// Separate lists: a single BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedV4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blockedV6.addSubnet(addr, prefix, 'ipv6');

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 4) return blockedV4.check(address, 'ipv4');
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms are refused outright.
  if (/^::(ffff:)?[\d.]+$|^::ffff:/i.test(address)) return true;
  return blockedV6.check(address, 'ipv6');
}

const fail = (status, code, message) => new HttpError(status, code, message);
const blocked = () => fail(422, 'remote_url_blocked', 'The URL points to a private or reserved network address');

/**
 * DNS lookup used for the actual socket connection. Validating here (instead of resolving once
 * up front) means the address we check is the address we connect to, which defeats DNS rebinding.
 */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true, family: options.family || 0 }, (err, addresses) => {
    if (err) return callback(err);
    if (!config.remoteUpload.allowPrivateNetworks && (!addresses.length || addresses.some((a) => isBlockedAddress(a.address)))) {
      return callback(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail(400, 'invalid_url', 'Invalid image URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail(400, 'invalid_url', 'Only http and https URLs are allowed');
  if (url.username || url.password) throw fail(400, 'invalid_url', 'URLs with credentials are not allowed');
  if (url.port && url.port !== '80' && url.port !== '443' && !config.remoteUpload.allowPrivateNetworks) throw fail(400, 'invalid_url', 'Only ports 80 and 443 are allowed');

  // IP literals skip DNS lookup entirely, so they must be checked here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !config.remoteUpload.allowPrivateNetworks && isBlockedAddress(host)) throw blocked();
  return url;
}

function filenameFrom(url) {
  let base = '';
  try {
    base = decodeURIComponent(path.posix.basename(url.pathname));
  } catch { /* malformed escape */ }
  return base || 'remote-image';
}

function requestOnce(url, deadline) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      lookup: safeLookup,
      agent: false,
      headers: {
        'User-Agent': 'MediaServer/1.0 (+remote upload)',
        Accept: 'image/avif,image/webp,image/*,application/pdf;q=0.9',
      },
    });

    const timer = setTimeout(() => req.destroy(fail(422, 'remote_timeout', 'Timed out fetching the URL')), deadline - Date.now());
    const done = (fn, value) => { clearTimeout(timer); fn(value); };

    req.on('error', (err) => {
      if (err instanceof HttpError) return done(reject, err);
      if (err.code === 'EBLOCKED') return done(reject, blocked());
      done(reject, fail(422, 'remote_fetch_failed', `Could not fetch the URL (${err.code || 'network error'})`));
    });

    req.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return done(resolve, { redirect: new URL(res.headers.location, url).toString() });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(reject, fail(422, 'remote_fetch_failed', `The URL responded with HTTP ${res.statusCode}`));
      }
      const declared = Number(res.headers['content-length']);
      if (declared > config.maxFileSize) {
        req.destroy();
        return done(reject, fail(413, 'file_too_large', 'Remote file exceeds the size limit'));
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.maxFileSize) {
          req.destroy(fail(413, 'file_too_large', 'Remote file exceeds the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => done(resolve, { buffer: Buffer.concat(chunks) }));
      res.on('error', (err) => req.emit('error', err));
    });
  });
}

/** Downloads an image/PDF from a public URL with SSRF, size, redirect and time limits. */
export async function fetchRemote(rawUrl) {
  if (!config.remoteUpload.enabled) throw fail(400, 'remote_upload_disabled', 'Uploading from URLs is disabled');
  const deadline = Date.now() + config.remoteUpload.timeoutMs;
  let url = validateUrl(rawUrl);

  for (let hops = 0; ; hops++) {
    const result = await requestOnce(url, deadline);
    if (!result.redirect) return { buffer: result.buffer, filename: filenameFrom(url) };
    if (hops >= config.remoteUpload.maxRedirects) throw fail(422, 'remote_fetch_failed', 'Too many redirects');
    url = validateUrl(result.redirect); // every hop is re-validated
  }
}
