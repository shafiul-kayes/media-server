// No top-level await anywhere in this module graph: hosts such as Hostinger (LiteSpeed lsnode)
// load the entry file with require(), which cannot load ES modules that use top-level await.
import { createApp } from './app.js';
import { startCleanupJob } from './cleanup.js';
import { config, validateConfig } from './config.js';
import { closeDb } from './db.js';
import { verifyMailer } from './mail/mailer.js';
import { checkServerSettings, migrate } from './schema.js';
import { ensureStorage } from './services/storage.js';

/**
 * Startup never exits on a configuration or database problem. The HTTP server comes up at once
 * and answers 503 (with a safe reason on /health) until the database is ready, and the database
 * connection is retried every 15 seconds. On managed hosts this turns an opaque "503 Service
 * Unavailable" into a readable reason, and the app recovers by itself once the problem is fixed
 * (for example after allowing the server's IP in Remote MySQL).
 */
const readiness = { ready: false, reason: 'starting' };
const RETRY_MS = 15_000;

let configOk = true;
try {
  validateConfig();
} catch (err) {
  configOk = false;
  readiness.reason = 'config_invalid';
  console.error(`[config] ${err.message}`);
  console.error('[config] Fix the environment variables in your hosting panel and redeploy.');
}

/** Maps driver errors to a short public reason; details only go to the log. */
function classifyDbError(err) {
  const code = err.code || '';
  if (code === 'ER_HOST_NOT_PRIVILEGED' || err.errno === 1130) return 'db_host_not_allowed';
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') return 'db_access_denied';
  if (code === 'ER_BAD_DB_ERROR') return 'db_not_found';
  if (/SSL|TLS|CERT|HANDSHAKE/i.test(code) || /ssl|certificate|secure transport/i.test(err.message)) return 'db_tls_error';
  if (['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST'].includes(code)) {
    return 'db_unreachable';
  }
  return 'db_error';
}

const HINTS = {
  db_host_not_allowed: 'The database refuses connections from this server. Allow this server\'s IP (shown in the message above) in your database\'s Remote MySQL / access list.',
  db_access_denied: 'Wrong DB_USER or DB_PASSWORD, or the user has no rights on DB_NAME.',
  db_not_found: 'DB_NAME does not exist on that server.',
  db_tls_error: 'TLS problem: set DB_SSL=true if the provider requires SSL; if it uses its own CA, paste the certificate into DB_SSL_CA.',
  db_unreachable: 'Cannot reach DB_HOST:DB_PORT. Check the host name and port, and that remote connections are enabled.',
  db_error: 'See the error above.',
};

let started = false;

async function initDatabase() {
  try {
    const ran = await migrate();
    if (ran.length) console.log(`[db] applied migration(s): ${ran.join(', ')}`);
    const { version, warning } = await checkServerSettings();
    console.log(`[db] connected to MySQL ${version} (${config.db.host}:${config.db.port}/${config.db.database}), storage driver: ${config.storageDriver}`);
    if (warning) console.warn(`[db] WARNING: ${warning}`);
    await ensureStorage();

    try {
      const smtp = await verifyMailer();
      console.log(smtp ? `[mail] SMTP ready (${smtp})` : '[mail] MAIL_TRANSPORT=log: emails are printed to this console, not sent');
    } catch (err) {
      // Not fatal: the site works, but verification/reset emails fail until SMTP is fixed.
      console.error(`[mail] SMTP check failed: ${err.message}. Verification and password-reset emails will not be delivered.`);
    }

    if (!started) {
      startCleanupJob();
      started = true;
    }
    readiness.ready = true;
    readiness.reason = 'ok';
    console.log('[startup] ready');
  } catch (err) {
    readiness.reason = classifyDbError(err);
    console.error(`[db] cannot connect to MySQL at ${config.db.host}:${config.db.port} as "${config.db.user}" (database "${config.db.database}", ssl=${config.db.ssl}): ${err.code || ''} ${err.message}`);
    console.error(`[db] ${HINTS[readiness.reason]} Retrying in ${RETRY_MS / 1000}s.`);
    setTimeout(initDatabase, RETRY_MS).unref();
  }
}

const server = createApp({ readiness }).listen(config.port, config.host, () => {
  console.log(`Media server listening on http://${config.host}:${config.port} (public URL: ${config.baseUrl})`);
});

// Slow-client (slowloris) protection.
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 5_000;

if (configOk) initDatabase();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
