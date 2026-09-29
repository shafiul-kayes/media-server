// Creates the MySQL database (if the user may) and all tables.
//   npm run db:setup           create database + run migrations
//   npm run db:schema          print the schema SQL (for phpMyAdmin / manual import)
import mysql from 'mysql2/promise';

const printOnly = process.argv.includes('--print-sql');

const { config, validateConfig } = await import('../src/config.js');
const { schemaSql } = await import('../src/schema.js');

if (printOnly) {
  process.stdout.write(schemaSql());
  process.exit(0);
}

try {
  validateConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const { connectionOptions, closeDb } = await import('../src/db.js');
const { checkServerSettings, migrate } = await import('../src/schema.js');
const { database, host, port, user } = config.db;

console.log(`Connecting to MySQL ${host}:${port} as "${user}"...`);

let admin;
try {
  admin = await mysql.createConnection(connectionOptions({ withDatabase: false }));
} catch (err) {
  console.error(`Connection failed: ${err.code || err.message}`);
  console.error('Check DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in .env and that MySQL is running.');
  process.exit(1);
}

try {
  // DB_NAME is validated to [A-Za-z0-9_] in validateConfig, so it is safe inside backticks.
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.log(`Database "${database}" is ready.`);
} catch (err) {
  if (err.code !== 'ER_DBACCESS_DENIED_ERROR' && err.code !== 'ER_ACCESS_DENIED_ERROR') throw err;
  console.log(`User "${user}" may not create databases; assuming "${database}" already exists (e.g. created in cPanel).`);
} finally {
  await admin.end();
}

try {
  const ran = await migrate();
  console.log(ran.length ? `Applied migration(s): ${ran.join(', ')}` : 'Schema is already up to date.');
  const { version, maxAllowedPacket, warning } = await checkServerSettings();
  console.log(`MySQL ${version}, max_allowed_packet = ${Math.round(maxAllowedPacket / 1048576)} MB, storage driver = ${config.storageDriver}`);
  if (warning) console.warn(`\nWARNING: ${warning}`);
  console.log('\nDone. Next: npm run create-key -- --name "My App"');
} catch (err) {
  console.error(`Setup failed: ${err.code || ''} ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
