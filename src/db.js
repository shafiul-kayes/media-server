import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { config } from './config.js';

function sslOptions() {
  if (!config.db.ssl) return undefined;
  return {
    ca: config.db.sslCa ? fs.readFileSync(config.db.sslCa) : undefined,
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
