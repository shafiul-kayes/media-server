import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ quiet: true });

const env = process.env;

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
const list = (value) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : value; // hop count, or a subnet list like "loopback, 10.0.0.0/8"
}

const port = int(env.PORT, 3000);

export const config = {
  env: env.NODE_ENV || 'development',
  port,
  host: env.HOST || '0.0.0.0',
  baseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),

  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: int(env.DB_PORT, 3306),
    user: env.DB_USER || '',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'media_server',
    connectionLimit: int(env.DB_CONNECTION_LIMIT, 10),
    ssl: bool(env.DB_SSL, false),
    sslCa: env.DB_SSL_CA || '',
    sslRejectUnauthorized: bool(env.DB_SSL_REJECT_UNAUTHORIZED, true),
  },

  // Where uploaded bytes are kept: inside MySQL (LONGBLOB) or as files in STORAGE_DIR.
  storageDriver: (env.STORAGE_DRIVER || 'mysql').toLowerCase(),
  storageDir: path.resolve(env.STORAGE_DIR || './storage'),

  adminToken: env.ADMIN_TOKEN || '',
  signingSecret: env.SIGNING_SECRET || '',

  maxFileSize: int(env.MAX_FILE_SIZE_MB, 10) * 1024 * 1024,
  maxImagePixels: int(env.MAX_IMAGE_PIXELS, 60_000_000),
  maxAnimationFrames: int(env.MAX_ANIMATION_FRAMES, 300),
  maxTransformDimension: int(env.MAX_TRANSFORM_DIMENSION, 4096),
  maxVariantsPerFile: int(env.MAX_VARIANTS_PER_FILE, 20),

  pdfBlockActiveContent: bool(env.PDF_BLOCK_ACTIVE_CONTENT, true),
  pdfAllowEncrypted: bool(env.PDF_ALLOW_ENCRYPTED, false),

  defaultQuotaBytes: int(env.DEFAULT_QUOTA_MB, 1024) * 1024 * 1024,
  maxExpirationSeconds: int(env.MAX_EXPIRATION_SECONDS, 15_552_000), // 180 days
  maxSignedUrlSeconds: int(env.MAX_SIGNED_URL_SECONDS, 7 * 24 * 3600),

  remoteUpload: {
    enabled: bool(env.REMOTE_UPLOAD_ENABLED, true),
    timeoutMs: int(env.REMOTE_UPLOAD_TIMEOUT_MS, 15_000),
    maxRedirects: int(env.REMOTE_UPLOAD_MAX_REDIRECTS, 3),
    // Never configurable from the environment: only tests flip this to fetch from localhost.
    allowPrivateNetworks: false,
  },

  appName: env.APP_NAME || 'Media Server',

  accounts: {
    registrationEnabled: bool(env.REGISTRATION_ENABLED, true),
    sessionIdleHours: int(env.SESSION_IDLE_HOURS, 12),
    sessionMaxDays: int(env.SESSION_MAX_DAYS, 7),
    maxLoginFailures: int(env.MAX_LOGIN_FAILURES, 5),
    lockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
    maxAppsPerUser: int(env.MAX_APPS_PER_USER, 10),
    maxPendingPerUser: int(env.MAX_PENDING_REQUESTS_PER_USER, 3),
    requireEmailVerification: bool(env.REQUIRE_EMAIL_VERIFICATION, true),
    verifyTokenHours: int(env.VERIFY_TOKEN_HOURS, 48),
    resetTokenMinutes: int(env.RESET_TOKEN_MINUTES, 60),
    inviteTokenDays: int(env.INVITE_TOKEN_DAYS, 7),
    notifyAdminsOnRequest: bool(env.NOTIFY_ADMINS_ON_REQUEST, true),
  },

  mail: {
    // smtp = send for real; log = print emails (with links) to the console, for development.
    transport: (env.MAIL_TRANSPORT || 'log').toLowerCase(),
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    secure: bool(env.SMTP_SECURE, false), // true for port 465 (implicit TLS)
    requireTls: bool(env.SMTP_REQUIRE_TLS, true), // refuse to send over plaintext on 587/25
    user: env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    from: env.MAIL_FROM || '',
    replyTo: env.MAIL_REPLY_TO || '',
  },

  corsOrigins: list(env.CORS_ORIGINS),
  frameAncestors: list(env.FRAME_ANCESTORS || '*'),

  rateLimit: {
    apiPer15Min: int(env.RATE_LIMIT_API_PER_15MIN, 300),
    uploadsPerHour: int(env.RATE_LIMIT_UPLOADS_PER_HOUR, 100),
    authFailuresPer15Min: int(env.RATE_LIMIT_AUTH_FAILURES_PER_15MIN, 20),
    publicPerMin: int(env.RATE_LIMIT_PUBLIC_PER_MIN, 600),
    transformsPerMin: int(env.RATE_LIMIT_TRANSFORMS_PER_MIN, 60),
    adminPer15Min: int(env.RATE_LIMIT_ADMIN_PER_15MIN, 50),
    deletePagePer15Min: int(env.RATE_LIMIT_DELETE_PAGE_PER_15MIN, 60),
    loginFailuresPer15Min: int(env.RATE_LIMIT_LOGIN_FAILURES_PER_15MIN, 10),
    registrationsPerHour: int(env.RATE_LIMIT_REGISTRATIONS_PER_HOUR, 5),
    panelPer15Min: int(env.RATE_LIMIT_PANEL_PER_15MIN, 600),
    passwordResetsPer15Min: int(env.RATE_LIMIT_PASSWORD_RESETS_PER_15MIN, 5),
  },
};

export function validateConfig() {
  const problems = [];
  if (config.adminToken.length < 32) problems.push('ADMIN_TOKEN must be at least 32 characters');
  if (config.signingSecret.length < 32) problems.push('SIGNING_SECRET must be at least 32 characters');
  if (config.adminToken && config.adminToken === config.signingSecret) {
    problems.push('ADMIN_TOKEN and SIGNING_SECRET must be different');
  }
  if (!['mysql', 'disk'].includes(config.storageDriver)) problems.push('STORAGE_DRIVER must be "mysql" or "disk"');
  if (!config.db.user) problems.push('DB_USER is required');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.db.database)) problems.push('DB_NAME may only contain letters, digits and _');
  if (config.env === 'production' && !config.db.password) problems.push('DB_PASSWORD must be set in production');
  if (!['smtp', 'log', 'memory'].includes(config.mail.transport)) problems.push('MAIL_TRANSPORT must be "smtp" or "log"');
  if (config.mail.transport === 'smtp') {
    if (!config.mail.host) problems.push('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
    if (!/^[^\r\n]*<?[^\s@<>]+@[^\s@<>]+>?$/.test(config.mail.from)) problems.push('MAIL_FROM must be an email address, e.g. "Media Server <no-reply@example.com>"');
  }
  for (const fa of config.frameAncestors) {
    if (/[;\s,'"]/.test(fa)) problems.push(`Invalid FRAME_ANCESTORS entry: ${fa}`);
  }
  if (problems.length) {
    throw new Error(`Invalid configuration (run "npm run setup" to generate .env):\n - ${problems.join('\n - ')}`);
  }
  if (config.env === 'production' && !config.baseUrl.startsWith('https://')) {
    console.warn(`[warn] PUBLIC_BASE_URL is "${config.baseUrl}". Set it to your https:// domain: links in emails and API `
      + 'responses use it, and cookies are only marked Secure when it is https.');
  }
  if (!process.env.PUBLIC_BASE_URL) {
    console.warn('[warn] PUBLIC_BASE_URL is not set; using http://localhost. Set it to the public address of this site.');
  }
  if (config.env === 'production' && config.mail.transport !== 'smtp') {
    console.warn('[warn] MAIL_TRANSPORT is not "smtp": verification and password-reset emails are only printed to the console');
  }
}
