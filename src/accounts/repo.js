import { pool, withTransaction } from '../db.js';

// All queries use `?` placeholders; values are never concatenated into SQL.

const toMs = (value) => (value instanceof Date ? value.getTime() : value ?? null);
const toDate = (ms) => (ms == null ? null : new Date(ms));

async function one(sql, params, conn = pool) {
  const [rows] = await conn.execute(sql, params);
  return rows[0];
}

function mapDates(row, fields) {
  if (!row) return undefined;
  const out = { ...row };
  for (const f of fields) if (f in out) out[f] = toMs(out[f]);
  return out;
}

const USER_DATES = ['email_verified_at', 'locked_until', 'created_at', 'last_login_at', 'password_changed_at'];
const APP_DATES = ['reviewed_at', 'created_at', 'updated_at', 'key_issued_at', 'last_used_at'];
const mapUser = (r) => mapDates(r, USER_DATES);
const mapApp = (r) => mapDates(r, APP_DATES);

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---- Users --------------------------------------------------------------------------------------

export const users = {
  async create({ name, email, passwordHash, role = 'user', emailVerified = false }) {
    const now = new Date();
    const [result] = await pool.execute(
      `INSERT INTO users (name, email, email_verified_at, password_hash, role, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, email, emailVerified ? now : null, passwordHash, role, now, now],
    );
    return result.insertId;
  },

  markVerified: (id) => pool.execute(
    'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?',
    [new Date(), id],
  ),

  /** After a successful password reset the account is unlocked (the owner proved control of the mailbox). */
  resetPassword: (id, passwordHash) => pool.execute(
    `UPDATE users SET password_hash = ?, password_changed_at = ?, failed_logins = 0, locked_until = NULL,
       email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
    [passwordHash, new Date(), new Date(), id],
  ),

  async listVerifiedAdmins() {
    const [rows] = await pool.execute(
      "SELECT id, name, email FROM users WHERE role = 'admin' AND status = 'active' AND email_verified_at IS NOT NULL",
    );
    return rows;
  },

  findById: async (id) => mapUser(await one('SELECT * FROM users WHERE id = ?', [id])),
  findByEmail: async (email) => mapUser(await one('SELECT * FROM users WHERE email = ?', [email])),

  async recordFailedLogin(id, maxFailures, lockMinutes) {
    // Lock the account for a while after too many consecutive failures, then start counting again.
    await pool.execute(
      `UPDATE users SET
         locked_until = IF(failed_logins + 1 >= ?, ?, locked_until),
         failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1)
       WHERE id = ?`,
      [maxFailures, new Date(Date.now() + lockMinutes * 60_000), maxFailures, id],
    );
  },

  recordLogin: (id) => pool.execute(
    'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?',
    [new Date(), id],
  ),

  setPassword: (id, passwordHash) => pool.execute(
    'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
    [passwordHash, new Date(), id],
  ),

  setName: (id, name) => pool.execute('UPDATE users SET name = ? WHERE id = ?', [name, id]),
  setStatus: (id, status) => pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, id]),
  setRole: (id, role) => pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, id]),

  async list({ search = '', limit, offset }) {
    const params = [];
    let where = '';
    if (search) {
      where = 'WHERE u.email LIKE ? OR u.name LIKE ?';
      params.push(likePattern(search), likePattern(search));
    }
    const [rows] = await pool.query(
      `SELECT u.*, (SELECT COUNT(*) FROM api_applications a WHERE a.user_id = u.id) AS app_count
       FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)],
    );
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM users u ${where}`, params);
    return { rows: rows.map(mapUser), total: Number(n) };
  },
};

// ---- Sessions -----------------------------------------------------------------------------------

export const sessions = {
  create: ({ idHash, userId, csrfToken, ip, userAgent, expiresAt }) => pool.execute(
    `INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [idHash, userId, csrfToken, ip, userAgent, new Date(), new Date(), toDate(expiresAt)],
  ),

  async find(idHash) {
    const row = await one(
      `SELECT s.id, s.user_id, s.csrf_token, s.created_at, s.last_seen_at, s.expires_at,
              u.name, u.email, u.role, u.status, u.email_verified_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      [idHash],
    );
    return mapDates(row, ['created_at', 'last_seen_at', 'expires_at', 'email_verified_at']);
  },

  touch: (idHash) => pool.execute('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [new Date(), idHash]),
  remove: (idHash) => pool.execute('DELETE FROM sessions WHERE id = ?', [idHash]),
  removeForUser: (userId, exceptIdHash = '') =>
    pool.execute('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, exceptIdHash]),
  async countForUser(userId) {
    return Number((await one('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', [userId, new Date()])).n);
  },
  purgeExpired: (idleCutoff) => pool.execute('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?', [new Date(), toDate(idleCutoff)]),
};

// ---- API applications (key requests) ------------------------------------------------------------

const APP_SELECT = `SELECT a.*, u.name AS user_name, u.email AS user_email, u.status AS user_status,
    r.name AS reviewer_name,
    k.prefix AS key_prefix, k.active AS key_active, k.key_issued_at, k.last_used_at, k.scopes AS key_scopes,
    k.allowed_origins AS key_origins, k.quota_bytes, k.used_bytes
  FROM api_applications a
  JOIN users u ON u.id = a.user_id
  LEFT JOIN users r ON r.id = a.reviewed_by
  LEFT JOIN api_keys k ON k.id = a.api_key_id`;

export const apps = {
  async create(row) {
    const now = new Date();
    const [result] = await pool.execute(
      `INSERT INTO api_applications (user_id, name, website, purpose, expected_volume, requested_scopes,
                                     requested_origins, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [row.userId, row.name, row.website, row.purpose, row.expectedVolume, row.requestedScopes, row.requestedOrigins, now, now],
    );
    return result.insertId;
  },

  findById: async (id) => mapApp(await one(`${APP_SELECT} WHERE a.id = ?`, [id])),

  /** Only returns the application if it belongs to `userId` (ownership check in SQL). */
  findForUser: async (id, userId) => mapApp(await one(`${APP_SELECT} WHERE a.id = ? AND a.user_id = ?`, [id, userId])),

  async listForUser(userId) {
    const [rows] = await pool.execute(`${APP_SELECT} WHERE a.user_id = ? ORDER BY a.created_at DESC`, [userId]);
    return rows.map(mapApp);
  },

  async countForUser(userId) {
    const row = await one(
      "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'pending'), 0) AS pending FROM api_applications WHERE user_id = ?",
      [userId],
    );
    return { total: Number(row.total), pending: Number(row.pending) };
  },

  async list({ status = null, limit, offset }) {
    const where = status ? 'WHERE a.status = ?' : '';
    const params = status ? [status] : [];
    const [rows] = await pool.query(`${APP_SELECT} ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...params, Number(limit), Number(offset)]);
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM api_applications a ${where}`, params);
    return { rows: rows.map(mapApp), total: Number(n) };
  },

  async statusCounts() {
    const [rows] = await pool.query('SELECT status, COUNT(*) AS n FROM api_applications GROUP BY status');
    const counts = { pending: 0, approved: 0, rejected: 0, revoked: 0 };
    for (const r of rows) counts[r.status] = Number(r.n);
    return counts;
  },

  /**
   * Approves a pending request: creates its API key and links it, atomically. The status check
   * in the UPDATE prevents double approval when two admins act at the same time.
   */
  approve: ({ id, reviewerId, note, key }) => withTransaction(async (conn) => {
    const now = new Date();
    await conn.execute(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes, quota_bytes, allowed_origins, created_at, key_issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [key.id, key.userId, key.name, key.keyHash, key.prefix, key.scopes, key.quotaBytes, key.allowedOrigins, now],
    );
    const [result] = await conn.execute(
      `UPDATE api_applications SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = ?, api_key_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      [note, reviewerId, now, key.id, now, id],
    );
    if (result.affectedRows !== 1) throw Object.assign(new Error('Application is no longer pending'), { conflict: true });
  }),

  async setStatus({ id, from, to, reviewerId, note }) {
    const now = new Date();
    const [result] = await pool.execute(
      `UPDATE api_applications SET status = ?, admin_note = COALESCE(?, admin_note), reviewed_by = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
      [to, note, reviewerId, now, now, id, from],
    );
    return result.affectedRows === 1;
  },
};

// ---- Audit log ----------------------------------------------------------------------------------

export const audit = {
  log: ({ actorId = null, action, target = null, details = null, ip = null }) => pool.execute(
    'INSERT INTO audit_logs (actor_id, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [actorId, action, target == null ? null : String(target).slice(0, 64), details == null ? null : String(details).slice(0, 1000), ip, new Date()],
  ),

  async list({ limit, offset, actorId = null }) {
    const where = actorId ? 'WHERE l.actor_id = ?' : '';
    const params = actorId ? [actorId] : [];
    const [rows] = await pool.query(
      `SELECT l.*, u.email AS actor_email FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
       ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)],
    );
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM audit_logs l ${where}`, params);
    return { rows: rows.map((r) => mapDates(r, ['created_at'])), total: Number(n) };
  },
};

export async function dashboardStats() {
  const row = await one(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE created_at >= ?) AS new_users,
      (SELECT COUNT(*) FROM files) AS files,
      (SELECT CAST(COALESCE(SUM(size), 0) AS UNSIGNED) FROM files) AS bytes`, [new Date(Date.now() - 7 * 86400_000)]);
  return { users: Number(row.users), newUsers: Number(row.new_users), files: Number(row.files), bytes: Number(row.bytes) };
}

/** Every API key with its owner and application, for the admin key list. */
export async function listKeys({ limit, offset }) {
  const [rows] = await pool.query(
    `SELECT k.id, k.name, k.prefix, k.scopes, k.active, k.quota_bytes, k.used_bytes, k.created_at, k.last_used_at,
            k.key_issued_at, u.id AS owner_id, u.email AS owner_email, a.id AS app_id
     FROM api_keys k LEFT JOIN users u ON u.id = k.user_id LEFT JOIN api_applications a ON a.api_key_id = k.id
     ORDER BY k.created_at DESC LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)],
  );
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM api_keys');
  return { rows: rows.map((r) => mapDates(r, ['created_at', 'last_used_at', 'key_issued_at'])), total: Number(n) };
}

// ---- One-time email tokens (verification, password reset, invitations) ----------------------------

export const tokens = {
  create: ({ idHash, userId, purpose, expiresAt, ip }) => pool.execute(
    'INSERT INTO user_tokens (id, user_id, purpose, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [idHash, userId, purpose, new Date(), toDate(expiresAt), ip],
  ),

  async find(idHash, purposes) {
    const row = await one(
      `SELECT t.id, t.user_id, t.purpose, t.expires_at, t.used_at, u.name, u.email, u.role, u.status, u.email_verified_at
       FROM user_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.id = ? AND t.purpose IN (${purposes.map(() => '?').join(', ')})`,
      [idHash, ...purposes],
    );
    return mapDates(row, ['expires_at', 'used_at', 'email_verified_at']);
  },

  /** Marks the token used. Only one concurrent caller can succeed, so a token works exactly once. */
  async consume(idHash) {
    const [result] = await pool.execute(
      'UPDATE user_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?',
      [new Date(), idHash, new Date()],
    );
    return result.affectedRows === 1;
  },

  /** Invalidates every outstanding token of these purposes for the user (e.g. older reset links). */
  invalidate: (userId, purposes) => pool.execute(
    `UPDATE user_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND purpose IN (${purposes.map(() => '?').join(', ')})`,
    [new Date(), userId, ...purposes],
  ),

  async countSince(userId, purpose, sinceMs) {
    const row = await one(
      'SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM user_tokens WHERE user_id = ? AND purpose = ? AND created_at >= ?',
      [userId, purpose, toDate(sinceMs)],
    );
    return { count: Number(row.n), latest: toMs(row.latest) };
  },

  purgeExpired: () => pool.execute('DELETE FROM user_tokens WHERE expires_at < ?', [new Date(Date.now() - 7 * 86400_000)]),
};
