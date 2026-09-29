import { pool, withTransaction } from './db.js';

// All queries use `?` placeholders; values are never concatenated into SQL.

const toMs = (value) => (value instanceof Date ? value.getTime() : value ?? null);
const toDate = (ms) => (ms == null ? null : new Date(ms));

function mapKey(row) {
  if (!row) return undefined;
  return {
    ...row,
    active: Number(row.active),
    created_at: toMs(row.created_at),
    last_used_at: toMs(row.last_used_at),
    key_issued_at: toMs(row.key_issued_at),
  };
}

function mapFile(row) {
  if (!row) return undefined;
  return { ...row, created_at: toMs(row.created_at), expires_at: toMs(row.expires_at) };
}

async function one(sql, params, conn = pool) {
  const [rows] = await conn.execute(sql, params);
  return rows[0];
}

const FILE_COLUMNS = `id, key_id, kind, mime, ext, size, width, height, pages, original_name, sha256,
  visibility, storage, created_at, expires_at, delete_token_hash`;

// ---- API keys -----------------------------------------------------------------------------------

const KEY_UPDATABLE = ['name', 'scopes', 'quota_bytes', 'active', 'allowed_origins'];

export const keys = {
  async create(row) {
    await pool.execute(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes, quota_bytes, allowed_origins, created_at, key_issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.userId ?? null, row.name, row.keyHash, row.prefix, row.scopes, row.quotaBytes, row.allowedOrigins,
        toDate(row.createdAt), toDate(row.keyIssuedAt)],
    );
  },

  /** Includes the owning user's status so a suspended user's keys stop working immediately. */
  findByHash: async (hash) => mapKey(await one(
    `SELECT k.*, u.status AS owner_status FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.key_issued_at IS NOT NULL`,
    [hash],
  )),
  findById: async (id) => mapKey(await one('SELECT * FROM api_keys WHERE id = ?', [id])),

  async list() {
    const [rows] = await pool.execute('SELECT * FROM api_keys ORDER BY created_at DESC');
    return rows.map(mapKey);
  },

  /** Replaces the secret (issue or rotate). The previous key stops working immediately. */
  setSecret: (id, keyHash, prefix) => pool.execute(
    'UPDATE api_keys SET key_hash = ?, prefix = ?, key_issued_at = ? WHERE id = ?',
    [keyHash, prefix, new Date(), id],
  ),

  async fileStats(id) {
    const row = await one('SELECT COUNT(*) AS n, CAST(COALESCE(SUM(size), 0) AS UNSIGNED) AS bytes FROM files WHERE key_id = ?', [id]);
    return { files: Number(row.n), bytes: Number(row.bytes) };
  },

  touch: (id, at = Date.now()) => pool.execute('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [toDate(at), id]),

  async update(id, fields) {
    // Column names come only from this whitelist, never from user input.
    const entries = Object.entries(fields).filter(([k, v]) => KEY_UPDATABLE.includes(k) && v !== undefined);
    if (!entries.length) return;
    const sql = `UPDATE api_keys SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
    await pool.execute(sql, [...entries.map(([, v]) => v), id]);
  },

  /** Deletes a key and all its files (blobs and variants cascade). Returns the files for disk cleanup. */
  remove: (id) => withTransaction(async (conn) => {
    const [owned] = await conn.execute('SELECT id, ext, storage FROM files WHERE key_id = ? FOR UPDATE', [id]);
    await conn.execute('DELETE FROM files WHERE key_id = ?', [id]);
    await conn.execute('DELETE FROM api_keys WHERE id = ?', [id]);
    return owned;
  }),
};

// ---- Files --------------------------------------------------------------------------------------

export const files = {
  findById: async (id) => mapFile(await one(`SELECT ${FILE_COLUMNS} FROM files WHERE id = ?`, [id])),

  async list({ keyId, kind = null, limit, offset }) {
    // LIMIT/OFFSET are validated integers; `query` is used because some MySQL versions reject them
    // as prepared-statement parameters. Values are still escaped by the driver.
    const [rows] = await pool.query(
      `SELECT ${FILE_COLUMNS} FROM files WHERE key_id = ? AND (? IS NULL OR kind = ?)
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [keyId, kind, kind, Number(limit), Number(offset)],
    );
    return rows.map(mapFile);
  },

  async count({ keyId, kind = null }) {
    const row = await one('SELECT COUNT(*) AS n FROM files WHERE key_id = ? AND (? IS NULL OR kind = ?)', [keyId, kind, kind]);
    return Number(row.n);
  },

  setVisibility: (id, visibility) => pool.execute('UPDATE files SET visibility = ? WHERE id = ?', [visibility, id]),

  async expired(now, limit = 500) {
    const [rows] = await pool.query(
      `SELECT ${FILE_COLUMNS} FROM files WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?`,
      [toDate(now), Number(limit)],
    );
    return rows.map(mapFile);
  },

  /**
   * Inserts the file row (plus its bytes when stored in MySQL) and charges the key's quota in one
   * transaction. The key row is locked so concurrent uploads cannot overshoot the quota.
   * Returns false if the quota would be exceeded.
   */
  insertWithQuota: (row, blob) => withTransaction(async (conn) => {
    const key = await one('SELECT used_bytes, quota_bytes FROM api_keys WHERE id = ? FOR UPDATE', [row.keyId], conn);
    if (!key || Number(key.used_bytes) + row.size > Number(key.quota_bytes)) return false;
    await conn.execute(
      `INSERT INTO files (id, key_id, kind, mime, ext, size, width, height, pages, original_name, sha256,
                          visibility, storage, created_at, expires_at, delete_token_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.keyId, row.kind, row.mime, row.ext, row.size, row.width, row.height, row.pages, row.originalName,
        row.sha256, row.visibility, row.storage, toDate(row.createdAt), toDate(row.expiresAt), row.deleteTokenHash],
    );
    if (blob) await conn.execute('INSERT INTO file_blobs (file_id, data) VALUES (?, ?)', [row.id, blob]);
    await conn.execute('UPDATE api_keys SET used_bytes = used_bytes + ? WHERE id = ?', [row.size, row.keyId]);
    return true;
  }),

  /** Deletes the row (blobs and variants cascade) and refunds the quota. */
  removeWithQuota: (file) => withTransaction(async (conn) => {
    const [result] = await conn.execute('DELETE FROM files WHERE id = ?', [file.id]);
    if (!result.affectedRows) return false;
    await conn.execute(
      'UPDATE api_keys SET used_bytes = IF(used_bytes > ?, used_bytes - ?, 0) WHERE id = ?',
      [file.size, file.size, file.key_id],
    );
    return true;
  }),
};

// ---- Bytes stored in MySQL ----------------------------------------------------------------------

export const blobs = {
  async read(fileId) {
    const row = await one('SELECT data FROM file_blobs WHERE file_id = ?', [fileId]);
    return row?.data;
  },

  async readVariant(fileId, name) {
    const row = await one('SELECT mime, data, created_at FROM file_variants WHERE file_id = ? AND name = ?', [fileId, name]);
    return row ? { mime: row.mime, data: row.data, createdAt: toMs(row.created_at) } : undefined;
  },

  async countVariants(fileId) {
    const row = await one('SELECT COUNT(*) AS n FROM file_variants WHERE file_id = ?', [fileId]);
    return Number(row.n);
  },

  // IGNORE: a concurrent request may have stored the same variant, or the file may just have been deleted.
  writeVariant: (fileId, name, mime, data) => pool.execute(
    'INSERT IGNORE INTO file_variants (file_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fileId, name, mime, data.length, data, new Date()],
  ),
};

export async function stats() {
  const row = await one(`SELECT
      (SELECT COUNT(*) FROM api_keys) AS key_count,
      (SELECT COUNT(*) FROM files) AS file_count,
      (SELECT CAST(COALESCE(SUM(size), 0) AS UNSIGNED) FROM files) AS total_bytes,
      (SELECT COUNT(*) FROM files WHERE storage = 'mysql') AS files_in_mysql,
      (SELECT COUNT(*) FROM files WHERE storage = 'disk') AS files_on_disk`, []);
  return {
    keys: Number(row.key_count),
    files: Number(row.file_count),
    bytes: Number(row.total_bytes),
    files_in_mysql: Number(row.files_in_mysql),
    files_on_disk: Number(row.files_on_disk),
  };
}
