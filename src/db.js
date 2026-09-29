import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { config } from './config.js';

/**
 * DB_SSL_CA may be empty/"none" (use the system CA store, fine for most cloud databases), the PEM
 * text itself (with real or "\n" line breaks, handy on hosts where you cannot upload files), or a
 * path to a .pem file.
 */
function loadCa(value) {
  const v = String(value ?? '').trim();
  if (!v || v.toLowerCase() === 'none') return undefined;
  if (v.includes('-----BEGIN')) return v.replace(/\\n/g, '\n');
  try {
    return fs.readFileSync(v);
  } catch (err) {
    // Do not crash at import time; the TLS handshake will then fail with a clear, logged error.
    console.error(`[db] DB_SSL_CA: cannot read "${v}" (${err.code}). Paste the certificate text instead, or use "none".`);
    return undefined;
  }
}

function sslOptions() {
  if (!config.db.ssl) return undefined;
  return {
    ca: loadCa(config.db.sslCa),
    rejectUnauthorized: config.db.sslRejectUnauthorized,
    minVersion: 'TLSv1.2',
  };
}

export function connectionOptions({ withDatabase = true } = {}) {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    ...(withDatabase ? { database: config.db.database } : {}),
    charset: 'utf8mb4',
    timezone: 'Z', // DATETIME values are stored and read as UTC
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    multipleStatements: false, // stacked queries are never allowed
    connectTimeout: 10_000,
    ssl: sslOptions(),
  };
}

export const pool = mysql.createPool({
  ...connectionOptions(),
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
});

/** Runs `fn(conn)` inside a transaction, committing on success and rolling back on any error. */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export const closeDb = () => pool.end();
