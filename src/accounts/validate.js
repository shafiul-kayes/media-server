import { config } from '../config.js';
import { SCOPES } from '../services/apiKeys.js';
import { normalizeOrigin } from '../services/origins.js';

/**
 * Form validators. Each returns `{ values, errors }`; `errors` maps field name to a Bengali
 * message and is empty when the input is valid. Values are trimmed and normalised.
 */

const clean = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const COMMON_PASSWORDS = new Set([
  'password123', '1234567890', '12345678910', 'qwertyuiop', 'password1234', 'iloveyou123', 'administrator',
  'bangladesh123', 'asdfghjkl1', 'abcdefghij', '0123456789', 'qwerty12345', 'letmein1234', 'welcome1234',
]);

export const VOLUMES = {
  lt1k: 'মাসে ১,০০০ এর কম',
  '1k-10k': 'মাসে ১,০০০ – ১০,০০০',
  '10k-100k': 'মাসে ১০,০০০ – ১,০০,০০০',
  gt100k: 'মাসে ১,০০,০০০ এর বেশি',
};

export const normalizeEmail = (value) => clean(value).toLowerCase();

export function validateName(value, errors, field = 'name') {
  const name = clean(value).replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) errors[field] = 'নাম ২ থেকে ১০০ অক্ষরের মধ্যে দিন';
  return name;
}

export function validatePassword(password, confirm, email, errors, field = 'password') {
  const pw = typeof password === 'string' ? password : '';
  if (pw.length < 10) errors[field] = 'পাসওয়ার্ড কমপক্ষে ১০ অক্ষরের হতে হবে';
  else if (pw.length > 128) errors[field] = 'পাসওয়ার্ড সর্বোচ্চ ১২৮ অক্ষর';
  else if (COMMON_PASSWORDS.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) errors[field] = 'এই পাসওয়ার্ডটি খুব সহজ, অন্য একটি দিন';
  else if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) {
    errors[field] = 'পাসওয়ার্ডে ইমেইলের নাম রাখবেন না';
  }
  if (confirm !== undefined && pw !== confirm) errors.password_confirm = 'দুটি পাসওয়ার্ড মেলেনি';
  return pw;
}

export function validateRegistration(body) {
  const errors = {};
  const name = validateName(body.name, errors);
  const email = normalizeEmail(body.email);
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'সঠিক ইমেইল ঠিকানা দিন';
  validatePassword(body.password, body.password_confirm, email, errors);
  if (body.terms !== 'yes') errors.terms = 'শর্তাবলিতে সম্মতি দিন';
  return { values: { name, email, password: body.password }, errors };
}

function parseOriginList(text, errors, field) {
  const items = clean(text).split(/[\s,]+/).filter(Boolean);
  if (items.length > 20) {
    errors[field] = 'সর্বোচ্চ ২০টি ডোমেইন দেওয়া যাবে';
    return [];
  }
  const origins = [];
  for (const item of items) {
    try {
      origins.push(normalizeOrigin(item));
    } catch {
      errors[field] = `"${item.slice(0, 60)}" সঠিক ডোমেইন নয়। যেমন: https://example.com অথবা https://*.example.com`;
      return [];
    }
  }
  return [...new Set(origins)];
}

function parseScopeList(value, errors, field) {
  const list = (Array.isArray(value) ? value : value ? [value] : []).map(String);
  const scopes = SCOPES.filter((s) => list.includes(s));
  if (!scopes.length) errors[field] = 'অন্তত একটি অনুমতি বাছাই করুন';
  return scopes;
}

export function validateAppRequest(body) {
  const errors = {};
  const name = clean(body.name).replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) errors.name = 'অ্যাপের নাম ২ থেকে ১০০ অক্ষরের মধ্যে দিন';

  let website = clean(body.website);
  if (website) {
    try {
      const url = new URL(website);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      website = url.toString().slice(0, 255);
    } catch {
      errors.website = 'সঠিক URL দিন, যেমন https://example.com';
    }
  }

  const purpose = clean(body.purpose);
  if (purpose.length < 20 || purpose.length > 2000) errors.purpose = 'ব্যবহারের উদ্দেশ্য ২০ থেকে ২০০০ অক্ষরের মধ্যে লিখুন';

  const expectedVolume = String(body.expected_volume ?? '');
  if (!(expectedVolume in VOLUMES)) errors.expected_volume = 'আনুমানিক ব্যবহার বাছাই করুন';

  const scopes = parseScopeList(body.scopes, errors, 'scopes');
  const origins = parseOriginList(body.origins, errors, 'origins');
  if (origins.includes('*')) errors.origins = '"*" (সব ডোমেইন) অনুরোধ করা যাবে না; নির্দিষ্ট ডোমেইন দিন';

  return { values: { name, website: website || null, purpose, expectedVolume, scopes, origins }, errors };
}

export function validateReview(body) {
  const errors = {};
  const scopes = parseScopeList(body.scopes, errors, 'scopes');
  const origins = parseOriginList(body.origins, errors, 'origins');
  const quotaMb = Number(body.quota_mb);
  if (!Number.isInteger(quotaMb) || quotaMb < 1 || quotaMb > 10_000_000) errors.quota_mb = '১ থেকে ১,০০,০০,০০০ এর মধ্যে MB দিন';
  const note = clean(body.note).slice(0, 1000) || null;
  return { values: { scopes, origins, quotaMb, note }, errors };
}

export const DEFAULT_QUOTA_MB = Math.round(config.defaultQuotaBytes / 1048576);
