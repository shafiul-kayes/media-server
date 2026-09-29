import { createDB } from 'mysql-memory-server';

/**
 * Starts a throw-away MySQL server for a test file and points the DB_* environment at it.
 * Must run before the app's modules are imported, since config is read at import time.
 * The MySQL binary is downloaded once (to the OS cache) on the very first run.
 */
export async function startTestMysql() {
  const db = await createDB({ version: '8.4.x', downloadBinaryOnce: true, logLevel: 'ERROR' });
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(db.port),
    DB_USER: db.username,
    DB_PASSWORD: '',
    DB_NAME: db.dbName,
  });
  return db;
}
