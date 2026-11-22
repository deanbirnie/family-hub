/**
 * The database: one SQLite file in the data folder, through Node's built-in
 * node:sqlite. Schema changes are numbered migrations that run once, in
 * order, at start-up; a database written by a newer server is refused rather
 * than guessed at.
 */
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

const MIGRATIONS: string[] = [
  // 1: accounts, sign-in, devices, invites, audit log
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    password_hash TEXT NOT NULL,
    -- base32; NULL until two-factor sign-in is set up
    totp_secret TEXT,
    -- offered during setup, kept until it is confirmed with a code
    totp_pending_secret TEXT,
    -- the last time step whose code was accepted, so no code works twice
    totp_last_counter INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    password_changed_at INTEGER NOT NULL
  );

  CREATE TABLE recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );

  -- Phones that sign in with a key kept in their hardware keystore, which
  -- only a fingerprint or face can unlock.
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- ECDSA P-256 public key, SubjectPublicKeyInfo DER, base64
    public_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE device_challenges (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- what the session may do: 'totp' and 'enroll' only finish signing in,
    -- 'device' only registers a phone, 'full' is signed in
    stage TEXT NOT NULL CHECK (stage IN ('totp', 'enroll', 'device', 'full')),
    transport TEXT NOT NULL CHECK (transport IN ('cookie', 'bearer')),
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    idle_seconds INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    event TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_log_user ON audit_log(user_id, at);
  `,
  // 2: shared documents. Disk paths use server-generated IDs, never names.
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES files(id),
    name TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
    size INTEGER NOT NULL DEFAULT 0,
    media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX files_name ON files(COALESCE(parent_id, ''), name);
  CREATE INDEX files_parent ON files(parent_id);
  `,
  // 3: recoverable deletion; an operation's root identifies its whole subtree.
  `
  ALTER TABLE files ADD COLUMN deleted_at INTEGER;
  ALTER TABLE files ADD COLUMN trash_root TEXT;
  DROP INDEX files_name;
  CREATE UNIQUE INDEX files_name ON files(COALESCE(parent_id, ''), name) WHERE deleted_at IS NULL;
  CREATE INDEX files_trash ON files(trash_root, deleted_at);
  `,
  // 4: document contents encrypted with the server key (docs/DATA-PROTECTION.md).
  // Existing documents start at 0 and are encrypted by encryptStoredData().
  `
  ALTER TABLE files ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
  `,
  // 5: the family vault (end-to-end; see routes/vault.ts). The server keeps
  // only wrapped copies of the family key, which it cannot open, and relays
  // pairing messages encrypted between two parent devices.
  `
  CREATE TABLE vault_keys (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('recovery', 'passkey', 'device')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    credential_id TEXT,
    prf_salt TEXT,
    label TEXT NOT NULL DEFAULT '',
    wrapped TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE UNIQUE INDEX vault_keys_recovery ON vault_keys(kind) WHERE kind = 'recovery';
  CREATE UNIQUE INDEX vault_keys_device ON vault_keys(device_id) WHERE device_id IS NOT NULL;
  CREATE INDEX vault_keys_user ON vault_keys(user_id);

  CREATE TABLE vault_pairings (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_by TEXT REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT
  );
  `,
  // 6: Quick Info (end-to-end; see routes/quick-info.ts). Profiles name the
  // people records belong to; each record's contents are ciphertext under the
  // family key, which the server never has.
  `
  CREATE TABLE family_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE quick_info (
    id TEXT PRIMARY KEY,
    profile_id TEXT REFERENCES family_profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'medical', 'passport', 'vehicle', 'policy', 'household')),
    ciphertext TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  -- One personal, medical aid and passport record per person; one household record.
  CREATE UNIQUE INDEX quick_info_single ON quick_info(COALESCE(profile_id, ''), kind) WHERE kind IN ('personal', 'medical', 'passport', 'household');
  CREATE INDEX quick_info_profile ON quick_info(profile_id);
  `,
  // 7: Family Contacts (server key; see routes/contacts.ts). Each contact's
  // details are one value sealed with the server key; emergency contacts for
  // a person are sealed on their profile.
  `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  ALTER TABLE family_profiles ADD COLUMN emergency TEXT;
  `,
  // 8: Notifications (see notifications.ts and docs/DATA-PROTECTION.md).
  // Reminder records hold only what, whose and when, so the server can send
  // them; push addresses are sealed with the server key.
  `
  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    -- where it came from: 'quick-info' (the record, and which date in it)
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    field TEXT NOT NULL,
    profile_id TEXT REFERENCES family_profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    -- YYYY-MM-DD, or --MM-DD for a yearly date without a year
    due TEXT NOT NULL,
    yearly INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, source_id, field)
  );
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- set for a phone, so removing the phone removes its push address
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('webpush', 'unifiedpush')),
    -- SHA-256 of the address, to recognise a browser registering again
    endpoint_hash TEXT NOT NULL UNIQUE,
    -- the address and the receiver's keys, sealed with the server key
    sealed TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    last_error TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    failing_since INTEGER
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
  -- which reminders each person has been sent (IDs and times only)
  CREATE TABLE reminder_deliveries (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    occurrence TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, occurrence)
  );
  CREATE TABLE notification_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings TEXT NOT NULL
  );
  `,
  // 9: Phones' daily background check (routes/notifications.ts). Each phone
  // holds a token that can only read its owner's due reminders (generic text);
  // only its hash is stored.
  `
  CREATE TABLE check_tokens (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_check_at INTEGER
  );
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `The database was written by a newer Family Hub (schema ${current}, this server knows ${SCHEMA_VERSION}). Run that version or newer.`,
    )
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}

/** Runs `fn` in a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
