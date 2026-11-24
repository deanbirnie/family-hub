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
  // 10: People and dates (phase 3). A contact can be one of the family's
  // Quick Info people (IDs only); relationships between contacts are sealed
  // with the server key, one value per relationship.
  `
  ALTER TABLE contacts ADD COLUMN profile_id TEXT REFERENCES family_profiles(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX contacts_profile ON contacts (profile_id) WHERE profile_id IS NOT NULL;
  CREATE TABLE contact_relations (
    id TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 11: Notes, timeline and gifts for each contact (phase 3), each entry
  // sealed with the server key and bound to its contact.
  `
  CREATE TABLE contact_notes (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX contact_notes_contact ON contact_notes (contact_id);
  CREATE TABLE contact_gifts (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX contact_gifts_contact ON contact_gifts (contact_id);
  `,
  // 12: Contact groups (phase 3): each group's name sealed with the server key;
  // who is in it is kept inside each (sealed) contact.
  `
  CREATE TABLE contact_groups (
    id TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 13: The family calendar (phase 4, routes/calendar.ts). Everything about an
  // event, times included, is one value sealed with the server key; each
  // person's calendar colour is plain.
  `
  ALTER TABLE family_profiles ADD COLUMN colour TEXT;
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  `,
  // 14: Outside calendars (phase 4c, routes/calendar-sync.ts): subscriptions
  // and inbox items sealed with the server key; which outside events were
  // accepted or ignored, by a hash of their source ID.
  `
  CREATE TABLE calendar_subscriptions (
    id TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    last_fetch_at INTEGER,
    last_ok_at INTEGER,
    last_error TEXT
  );
  CREATE TABLE calendar_inbox (
    id TEXT PRIMARY KEY,
    subscription_id TEXT REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
    uid_hash TEXT NOT NULL,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX calendar_inbox_uid ON calendar_inbox (uid_hash);
  CREATE TABLE calendar_links (
    uid_hash TEXT PRIMARY KEY,
    subscription_id TEXT REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK (state IN ('accepted', 'ignored')),
    fingerprint TEXT NOT NULL
  );
  `,
  // 15: Health (phase 5, routes/health.ts). Each health record is encrypted on
  // a parent's device with the family key; the server keeps only whose it is
  // and when it changed. A folder (and all in it) can be for parents only.
  `
  ALTER TABLE files ADD COLUMN parents_only INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE health_records (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES family_profiles(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX health_records_profile ON health_records (profile_id);
  `,
  // 16: Health reminders (phase 5b): a parent's device registers only "a
  // health reminder · person · date", with how many days ahead to remind.
  `
  ALTER TABLE reminders ADD COLUMN leads TEXT;
  `,
  // 17: Household admin (phase 6, routes/household.ts): accounts (a bank and a
  // nickname), bills and subscriptions, and invoices, each sealed with the
  // server key and bound to its ID. Only the kind of item is plain.
  `
  CREATE TABLE household (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('account', 'bill', 'invoice')),
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX household_kind ON household (kind);
  `,
  // 18: Home and car (phase 6b, routes/home-care.ts): vehicles (linked to a
  // Quick Info vehicle by ID), things with warranties, recurring maintenance
  // and jobs done. Sealed with the server key; only the kind is plain.
  `
  CREATE TABLE home_care (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('vehicle', 'item', 'task', 'job')),
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX home_care_kind ON home_care (kind);
  `,
  // 19: The budget (phase 6c, routes/budget.ts): categories, month plans,
  // planned expenses, debts, rules and milestones, each sealed with the
  // server key. Transactions are sealed one by one; only their month is plain
  // (to read one month at a time), and a keyed fingerprint recognises ones
  // already imported. Import formats hold no personal data.
  `
  CREATE TABLE budget (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('categories', 'month', 'planned', 'debt', 'rule', 'milestones')),
    key TEXT,
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (kind, key)
  );
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    fingerprint TEXT UNIQUE,
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX transactions_month ON transactions (month);
  CREATE TABLE import_formats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    signature TEXT NOT NULL,
    mapping TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 20: School (phase 7, routes/school.ts): each child's school years,
  // school contacts, extra-murals, reminders (and later forms, lists,
  // homework), sealed with the server key. Plain: the kind and whose it is.
  `
  CREATE TABLE school (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('year', 'contact', 'activity', 'reminder', 'form', 'list', 'homework', 'timetable')),
    profile_id TEXT REFERENCES family_profiles(id) ON DELETE CASCADE,
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX school_profile ON school (profile_id);
  `,
  // 21: Wishlists (phase 8, routes/wishlists.ts): each person's wishlist
  // items and sizes card, and who is getting what. Sealed with the server key.
  // A claim is kept apart from its item so the list's owner never receives it.
  `
  CREATE TABLE wishlist (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES family_profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('item', 'sizes')),
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX wishlist_profile ON wishlist (profile_id);
  CREATE TABLE wishlist_claims (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES wishlist(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX wishlist_claims_item ON wishlist_claims (item_id);
  `,
  // 22: share links for the children's wishlists (8b). The token is kept
  // only as a hash; a visitor's claim has no account but an undo secret, hashed.
  `
  CREATE TABLE wishlist_links (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES family_profiles(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    off_at INTEGER
  );
  CREATE INDEX wishlist_links_profile ON wishlist_links (profile_id);
  ALTER TABLE wishlist_claims ADD COLUMN link_id TEXT REFERENCES wishlist_links(id) ON DELETE SET NULL;
  ALTER TABLE wishlist_claims ADD COLUMN undo_hash TEXT;
  `,
  // 23: In case of emergency (phase 9a, routes/emergency.ts): the trusted
  // parties, each sealed, with the hash of the request link in their letter.
  `
  CREATE TABLE trusted_parties (
    id TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    request_hash TEXT UNIQUE,
    letter_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  `,
  // 24: the emergency pack (phase 9b): the parents' instructions and the
  // pack's password, each end-to-end encrypted with the family key (the
  // server cannot read them), and the pack itself, a PDF locked with that
  // password on a parent's device.
  `
  CREATE TABLE emergency_secrets (
    kind TEXT PRIMARY KEY CHECK (kind IN ('instructions', 'password')),
    ciphertext TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE emergency_pack (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pdf BLOB NOT NULL,
    made_at INTEGER NOT NULL,
    made_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    downloaded_at INTEGER
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
