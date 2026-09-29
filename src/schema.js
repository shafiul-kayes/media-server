import { config } from './config.js';
import { pool } from './db.js';

// IDs are case-sensitive base64url strings, so they use a binary collation: with MySQL's default
// case-insensitive collation "abc" and "ABC" would be treated as the same key.
const ID = 'CHARACTER SET ascii COLLATE ascii_bin';
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

/** Ordered, append-only list of schema changes. Never edit an applied migration; add a new one. */
export const migrations = [
  {
    version: 1,
    name: 'initial schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS api_keys (
        id              VARCHAR(32) ${ID} NOT NULL,
        name            VARCHAR(100) NOT NULL,
        key_hash        CHAR(64) ${ID} NOT NULL COMMENT 'SHA-256 of the API key; the key itself is never stored',
        prefix          VARCHAR(16) ${ID} NOT NULL,
        scopes          VARCHAR(64) CHARACTER SET ascii NOT NULL,
        allowed_origins TEXT CHARACTER SET ascii NOT NULL,
        quota_bytes     BIGINT UNSIGNED NOT NULL,
        used_bytes      BIGINT UNSIGNED NOT NULL DEFAULT 0,
        active          TINYINT(1) NOT NULL DEFAULT 1,
        created_at      DATETIME(3) NOT NULL,
        last_used_at    DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_api_keys_key_hash (key_hash)
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS files (
        id                CHAR(16) ${ID} NOT NULL,
        key_id            VARCHAR(32) ${ID} NOT NULL,
        kind              ENUM('image', 'pdf') NOT NULL,
        mime              VARCHAR(64) CHARACTER SET ascii NOT NULL,
        ext               VARCHAR(8) CHARACTER SET ascii NOT NULL,
        size              INT UNSIGNED NOT NULL,
        width             INT UNSIGNED NULL,
        height            INT UNSIGNED NULL,
        pages             INT UNSIGNED NULL,
        original_name     VARCHAR(255) NOT NULL,
        sha256            CHAR(64) CHARACTER SET ascii NOT NULL,
        visibility        ENUM('public', 'private') NOT NULL DEFAULT 'public',
        storage           ENUM('mysql', 'disk') NOT NULL COMMENT 'Where the bytes live',
        created_at        DATETIME(3) NOT NULL,
        expires_at        DATETIME(3) NULL,
        delete_token_hash CHAR(64) ${ID} NULL,
        PRIMARY KEY (id),
        KEY idx_files_key_created (key_id, created_at),
        KEY idx_files_expires (expires_at),
        CONSTRAINT fk_files_key FOREIGN KEY (key_id) REFERENCES api_keys (id)
      ) ${TABLE}`,

      // Bytes are kept apart from metadata so listing files never reads the blobs.
      `CREATE TABLE IF NOT EXISTS file_blobs (
        file_id CHAR(16) ${ID} NOT NULL,
        data    LONGBLOB NOT NULL,
        PRIMARY KEY (file_id),
        CONSTRAINT fk_file_blobs_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS file_variants (
        file_id    CHAR(16) ${ID} NOT NULL,
        name       VARCHAR(64) ${ID} NOT NULL COMMENT 'e.g. 320x320-cover-q80.webp',
        mime       VARCHAR(64) CHARACTER SET ascii NOT NULL,
        size       INT UNSIGNED NOT NULL,
        data       LONGBLOB NOT NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (file_id, name),
        CONSTRAINT fk_file_variants_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
      ) ${TABLE}`,
    ],
  },
  {
    version: 2,
    name: 'user accounts and api applications',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
        name                VARCHAR(100) NOT NULL,
        email               VARCHAR(254) NOT NULL,
        password_hash       VARCHAR(255) ${ID} NOT NULL COMMENT 'scrypt$N$r$p$salt$hash',
        role                ENUM('user', 'admin') NOT NULL DEFAULT 'user',
        status              ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
        failed_logins       INT UNSIGNED NOT NULL DEFAULT 0,
        locked_until        DATETIME(3) NULL,
        created_at          DATETIME(3) NOT NULL,
        last_login_at       DATETIME(3) NULL,
        password_changed_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email)
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS sessions (
        id           CHAR(64) ${ID} NOT NULL COMMENT 'SHA-256 of the cookie token; the token itself is never stored',
        user_id      INT UNSIGNED NOT NULL,
        csrf_token   CHAR(43) ${ID} NOT NULL,
        ip           VARCHAR(45) CHARACTER SET ascii NULL,
        user_agent   VARCHAR(255) NULL,
        created_at   DATETIME(3) NOT NULL,
        last_seen_at DATETIME(3) NOT NULL,
        expires_at   DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_sessions_user (user_id),
        KEY idx_sessions_expires (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ${TABLE}`,

      `ALTER TABLE api_keys
        ADD COLUMN user_id INT UNSIGNED NULL AFTER id,
        ADD COLUMN key_issued_at DATETIME(3) NULL COMMENT 'NULL until the owner generates the key',
        ADD KEY idx_api_keys_user (user_id),
        ADD CONSTRAINT fk_api_keys_user FOREIGN KEY (user_id) REFERENCES users (id)`,

      'UPDATE api_keys SET key_issued_at = created_at WHERE key_issued_at IS NULL',

      `CREATE TABLE IF NOT EXISTS api_applications (
        id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id           INT UNSIGNED NOT NULL,
        name              VARCHAR(100) NOT NULL,
        website           VARCHAR(255) NULL,
        purpose           TEXT NOT NULL,
        expected_volume   VARCHAR(32) CHARACTER SET ascii NOT NULL,
        requested_scopes  VARCHAR(64) CHARACTER SET ascii NOT NULL,
        requested_origins TEXT CHARACTER SET ascii NOT NULL,
        status            ENUM('pending', 'approved', 'rejected', 'revoked') NOT NULL DEFAULT 'pending',
        admin_note        VARCHAR(1000) NULL,
        reviewed_by       INT UNSIGNED NULL,
        reviewed_at       DATETIME(3) NULL,
        api_key_id        VARCHAR(32) ${ID} NULL,
        created_at        DATETIME(3) NOT NULL,
        updated_at        DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_apps_user (user_id, created_at),
        KEY idx_apps_status (status, created_at),
        UNIQUE KEY uq_apps_api_key (api_key_id),
        CONSTRAINT fk_apps_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_apps_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_apps_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE SET NULL
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS audit_logs (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_id   INT UNSIGNED NULL,
        action     VARCHAR(64) CHARACTER SET ascii NOT NULL,
        target     VARCHAR(64) NULL,
        details    VARCHAR(1000) NULL,
        ip         VARCHAR(45) CHARACTER SET ascii NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_audit_created (created_at),
        KEY idx_audit_actor (actor_id, created_at),
        CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
      ) ${TABLE}`,
    ],
  },
  {
    version: 3,
    name: 'email verification and password reset',
    statements: [
      'ALTER TABLE users ADD COLUMN email_verified_at DATETIME(3) NULL AFTER email',
      // Accounts created before verification existed are treated as verified so nobody is locked out.
      'UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL',

      `CREATE TABLE IF NOT EXISTS user_tokens (
        id         CHAR(64) ${ID} NOT NULL COMMENT 'SHA-256 of the emailed token; the token itself is never stored',
        user_id    INT UNSIGNED NOT NULL,
        purpose    ENUM('verify_email', 'reset_password', 'invite') NOT NULL,
        created_at DATETIME(3) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        used_at    DATETIME(3) NULL,
        ip         VARCHAR(45) CHARACTER SET ascii NULL,
        PRIMARY KEY (id),
        KEY idx_user_tokens_user (user_id, purpose, created_at),
        KEY idx_user_tokens_expires (expires_at),
        CONSTRAINT fk_user_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ${TABLE}`,
    ],
  },
];

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ${TABLE}`;

/** Full schema as a SQL script, for importing by hand (phpMyAdmin, mysql CLI). */
export function schemaSql() {
  const lines = [
    '-- Media Server database schema (generated by: npm run db:schema)',
    '-- Import into an existing, empty database, e.g.: mysql -u USER -p media_server < database/schema.sql',
    '',
    `${MIGRATIONS_TABLE};`,
    '',
  ];
  for (const m of migrations) {
    lines.push(`-- Migration ${m.version}: ${m.name}`);
    for (const s of m.statements) lines.push(`${s.replace(/^ {6}/gm, '')};`, '');
    lines.push(`INSERT IGNORE INTO schema_migrations (version, name) VALUES (${m.version}, '${m.name}');`, '');
  }
  return lines.join('\n');
}

/**
 * Applies pending migrations. A named lock stops two server instances starting at the same time
 * from migrating concurrently.
 */
export async function migrate() {
  const conn = await pool.getConnection();
  try {
    const [[{ locked }]] = await conn.query("SELECT GET_LOCK('media_server_migrate', 30) AS locked");
    if (locked !== 1) throw new Error('Could not acquire the migration lock');
    try {
      await conn.query(MIGRATIONS_TABLE);
      const [rows] = await conn.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.version));
      const ran = [];
      for (const m of migrations) {
        if (applied.has(m.version)) continue;
        for (const statement of m.statements) await conn.query(statement);
        await conn.execute('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
        ran.push(m.version);
      }
      return ran;
    } finally {
      await conn.query("SELECT RELEASE_LOCK('media_server_migrate')");
    }
  } finally {
    conn.release();
  }
}

/**
 * MySQL rejects any single packet larger than max_allowed_packet, so with the MySQL storage
 * driver it must comfortably exceed the largest upload. Returns a warning string, if any.
 */
export async function checkServerSettings() {
  const [[row]] = await pool.query('SELECT @@max_allowed_packet AS packet, VERSION() AS version');
  const needed = config.maxFileSize + 2 * 1024 * 1024;
  const warning = config.storageDriver === 'mysql' && row.packet < needed
    ? `max_allowed_packet is ${Math.round(row.packet / 1048576)} MB but uploads can be ${Math.round(config.maxFileSize / 1048576)} MB. ` +
      `Set max_allowed_packet=${Math.ceil(needed / 1048576) + 4}M in my.cnf / my.ini (under [mysqld]) and restart MySQL.`
    : null;
  return { version: row.version, maxAllowedPacket: row.packet, warning };
}
