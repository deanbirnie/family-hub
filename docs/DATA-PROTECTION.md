# Data protection register

What Family Hub stores, and how each piece is protected. **Every phase fills
in its rows here before any code is written** (see "When building a phase"
below). Changing a decision later is possible but costly, and moving data
*into* end-to-end encryption is the hardest change of all, so decide up front.

Companion documents: [SECURITY.md](SECURITY.md) (how sign-in and requests are
protected) and [ROADMAP.md](ROADMAP.md) (what each phase builds).

## The tiers

| Tier | What it means | Who can read it | Use it for |
|---|---|---|---|
| **E2E: family key** | Encrypted on a parent's device before upload (AES-256-GCM). The server stores ciphertext only and never holds the key. | Parents' unlocked devices. Not the server, not its owner, not a stolen backup. | Identity, financial and health details whose leak would cause real harm: ID numbers, tax numbers, medical aid numbers, medical history. |
| **S: server key** | Encrypted at rest by the server with a key file kept **outside** the database volume. | The running server (so it can search, sync, send and share it). A copied database or backup alone reveals nothing. | Personal data the server must work with: contacts, authenticator secrets, push addresses, calendar entries. |
| **H: hashed** | Only a one-way hash is stored. | Nobody: the value can be checked but never recovered. | Passwords (Argon2id), session, invite and recovery-code tokens (SHA-256). |
| **P: plain** | Stored as-is. Protected by sign-in, server-side access checks and the server's disk permissions. | The server, and anyone with the database or volume. | Data that is not personal or is needed in the clear: settings, IDs, timestamps, reminder dates, the audit log. |

Every tier is also behind sign-in and server-side access rules. Tiers are
about what a **stolen database, backup or disk** reveals, and about what the
**server itself** can read.

### Choosing a tier

1. Would a leak enable identity theft, fraud, or expose health information?
   → **E2E**, unless the server must read it to work.
2. Must the server read it (to search it, sync it to other apps, send
   notifications from it, or check it)? → **S** at most. If it must be both
   protected from the server *and* used by it, split it: keep the sensitive
   value E2E and give the server only the minimum it needs in S or P (as
   reminders do: "Passport renewal · Sam · 1 March 2027" is P, the passport
   number is E2E).
3. Only ever checked, never shown again? → **H**.
4. Not personal, or harmless if read? → **P**.

### What changing a tier later costs

| Change | Cost |
|---|---|
| P → S, or S → P | Low. The server can re-encrypt or decrypt existing data itself in a migration. |
| S or P → E2E | **High.** The server must not keep a readable copy, so every record has to be re-encrypted by a parent's unlocked device, the plaintext deleted, and old backups treated as exposed. Features that relied on the server reading the data (search, sync, notifications) must be redesigned. |
| E2E → S or P | Medium. Needs a parent's unlocked device to decrypt and upload, and gives up the protection. |
| Anything → H | Only for values that can be re-entered (the old values are lost). |

## The keys

| Key | Where it lives | Backed up to |
|---|---|---|
| Family key | Wrapped per parent device: Android Keystore (fingerprint or face), browser passkey (WebAuthn PRF). Shared between parents through per-parent key pairs. | The **recovery key**, shown once when the family key is created, kept in the owner's password manager. |
| Server key | A key file outside the `/data` volume (a separate mount or a Docker secret). | The owner's password manager. **Never back it up alongside `/data`**, or S data in that backup is as good as plain. |

## Register

Status: ✅ in place · 🔜 planned for the phase shown · ❓ to decide.

### Accounts and sign-in (phase 0)

| Data | Where | Tier | Status |
|---|---|---|---|
| Usernames, display names, roles | `users` | P | ✅ |
| Passwords | `users.password_hash` | H (Argon2id) | ✅ |
| Authenticator (TOTP) secrets | `users.totp_secret`, `totp_pending_secret` | S | 🔜 phase 2 (P today) |
| Recovery codes | `recovery_codes` | H (SHA-256) | ✅ |
| Session and invite tokens | `sessions`, `invites` | H (SHA-256) | ✅ |
| Phone public keys, device names | `devices` | P (public keys are not secret) | ✅ |
| Phone private keys | Android Keystore, on the phone | Never leaves the hardware | ✅ |
| Audit log: events, times, IP addresses | `audit_log` | P (kept one year) | ✅ |
| Family name, settings | `settings` | P | ✅ |

### Shared documents (phase 1)

| Data | Where | Tier | Status |
|---|---|---|---|
| Document contents | `/data/files/<id>` | **P** | ✅ as built. ❓ See the open question below. |
| File and folder names, sizes, types, dates | `files` | P | ✅ |
| Recycle bin (deleted documents for 30 days) | `files`, `/data/files` | Same as live documents | ✅ |
| Opened or saved copies on Android | App cache `documents/` | Plain on the phone; deleted when the app locks or starts | ✅ |

**Open question: should document contents move to S?** Phase 1 is for
important paperwork (certificates, ID scans), and today a copy of `/data`
reveals all of it. Moving to S is a low-cost change (the server can encrypt
existing files itself), so it can be done at any time; the main trade-off is
that the files on disk are no longer readable directly from a backup without
the server key. Proposed: **S**, as a small pull request alongside phase 2's
server key.

### Quick Info (phase 2)

| Data | Where | Tier | Status |
|---|---|---|---|
| Personal details: legal name, SA ID number, date of birth, SARS tax number | Quick Info records | E2E | 🔜 |
| Medical aid: scheme, plan, membership number, main member, dependant codes | Quick Info records | E2E | 🔜 |
| Household street and postal addresses | Quick Info records | E2E | 🔜 |
| Passport numbers, vehicle registrations, insurance policy numbers | Quick Info records | E2E | 🔜 |
| Which person a record belongs to, its type, when it changed | Record metadata | P (the server needs it to list and sync) | 🔜 |
| Links to documents and contacts | Record contents | E2E | 🔜 |
| Family profiles without accounts (children): name | Profiles | P (names appear across the hub) | 🔜 |

### Family Contacts (phase 2)

| Data | Where | Tier | Status |
|---|---|---|---|
| Names, organisations, roles, phone numbers, emails, addresses, notes | Contact cards | S (allows CardDAV sync later) | 🔜 |
| Emergency-contact designations | Contact links | S | 🔜 |

### Notifications (phase 2)

| Data | Where | Tier | Status |
|---|---|---|---|
| Reminder records: what, whose, when | Reminders | P (the server sends them) | 🔜 |
| Push addresses (UnifiedPush and Web Push endpoints) and their keys | Push subscriptions | S | 🔜 |
| Background-check tokens (read reminders only) | Tokens | H | 🔜 |
| Notification text | Sent to the push service | Encrypted in transit (RFC 8291); generic wording only | 🔜 |

### Later phases (proposed; confirm at the start of each phase)

| Phase | Data | Proposed tier | Why |
|---|---|---|---|
| 3 Calendar | Events, locations, notes | S | Calendar sync (iCal feeds, maybe CalDAV) needs the server to read them. |
| 4 Lists, chores, noticeboard | Items, chores, notices | P | Everyday and low-risk; live sync is simpler. |
| 5 Meals | Plans, recipes | P | Not personal. Allergies come from Health, not stored here. |
| 6 Household admin | Bills, amounts, budgets | S | Financial, but the server must send due-date reminders. |
| 6 Household admin | Bank account or card numbers | E2E, or don't store at all | Fraud risk. |
| 6 Home & car | Service history, warranties | P or S | Low risk; decide with the phase. |
| 7 Health | Allergies, conditions, medications, history, treatment plans | E2E | Health data; already agreed. |
| 7 Health | Repeat-prescription reminders | P (what · whose · when only) | Same split as Quick Info reminders. |
| 7 Health | Offline emergency card on the phone | E2E, opened by biometric | Already agreed. |
| 8 Gift ideas | Ideas per person | S | Hidden from the recipient by access rules, not encryption. |
| 8 In case of emergency | Instructions for a trusted person | ❓ | Released after a waiting period, which needs either server access (S) or key escrow to the trusted person (E2E). Decide with the phase. |

## When building a phase

Before writing code for a phase or module:

1. List every new piece of data it stores, including metadata, caches on
   phones, notifications, logs and exports.
2. Choose a tier for each, using "Choosing a tier", and add the rows here
   (✅ once built, 🔜 while planned).
3. If anything is E2E, decide what the server still needs in S or P to make
   the feature work, and record that split.
4. Get the owner's agreement on the rows in the phase's planning pull request,
   before the build pull requests.
5. In each build pull request, check the code matches the rows, and test
   that a copy of the database alone does not reveal S or E2E values.
