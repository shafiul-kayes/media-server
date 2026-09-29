import { config, validateConfig } from './config.js';

try {
  validateConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const { createApp } = await import('./app.js');
const { closeDb } = await import('./db.js');
const { checkServerSettings, migrate } = await import('./schema.js');
const { ensureStorage } = await import('./services/storage.js');
const { startCleanupJob } = await import('./cleanup.js');

try {
  const ran = await migrate();
  if (ran.length) console.log(`[db] applied migration(s): ${ran.join(', ')}`);
  const { version, warning } = await checkServerSettings();
  console.log(`[db] connected to MySQL ${version} (${config.db.host}:${config.db.port}/${config.db.database}), storage driver: ${config.storageDriver}`);
  if (warning) console.warn(`[db] WARNING: ${warning}`);
} catch (err) {
  console.error(`[db] Could not connect to MySQL at ${config.db.host}:${config.db.port} as "${config.db.user}": ${err.code || err.message}`);
  console.error('    Check the DB_* settings in .env and run "npm run db:setup".');
  process.exit(1);
}

await ensureStorage();

const { verifyMailer } = await import('./mail/mailer.js');
try {
  const smtp = await verifyMailer();
  console.log(smtp ? `[mail] SMTP ready (${smtp})` : '[mail] MAIL_TRANSPORT=log: emails are printed to this console, not sent');
} catch (err) {
  // Not fatal: the site works, but verification/reset emails will fail until SMTP is fixed.
  console.error(`[mail] SMTP check failed: ${err.message}. Verification and password-reset emails will not be delivered.`);
}

const server = createApp().listen(config.port, config.host, () => {
  console.log(`Media server listening on http://${config.host}:${config.port} (public URL: ${config.baseUrl})`);
});

// Slow-client (slowloris) protection.
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 5_000;

startCleanupJob();

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
