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
| Server key | A key file outside the `/data` volume (a separate mount or a Docker secret). | The owner's password manager. Parents are reminded in the app until one confirms it is saved; **Settings → Server key** shows it after a fresh authenticator code (each showing is logged). **Never back it up alongside `/data`**, or S data in that backup is as good as plain. |

## Register

Status: ✅ in place · 🔜 planned for the phase shown · ❓ to decide.

### Accounts and sign-in (phase 0)

| Data | Where | Tier | Status |
|---|---|---|---|
| Usernames, display names, roles | `users` | P | ✅ |
| Passwords | `users.password_hash` | H (Argon2id) | ✅ |
| Authenticator (TOTP) secrets | `users.totp_secret`, `totp_pending_secret` | S (bound to the user) | ✅ phase 2 |
| Recovery codes | `recovery_codes` | H (SHA-256) | ✅ |
| Session and invite tokens | `sessions`, `invites` | H (SHA-256) | ✅ |
| Phone public keys, device names | `devices` | P (public keys are not secret) | ✅ |
| Phone private keys | Android Keystore, on the phone | Never leaves the hardware | ✅ |
| Audit log: events, times, IP addresses | `audit_log` | P (kept one year) | ✅ |
| Family name, settings (including when the server key was confirmed saved, and by whom) | `settings` | P | ✅ |

### Shared documents (phase 1)

| Data | Where | Tier | Status |
|---|---|---|---|
| Document contents | `/data/files/<id>` | S (chunked, bound to the document) | ✅ phase 2 |
| File and folder names, sizes, types, dates | `files` | P | ✅ |
| Recycle bin (deleted documents for 30 days) | `files`, `/data/files` | S, like live documents | ✅ |
| Opened or saved copies on Android | App cache `documents/` | Plain on the phone; deleted when the app locks or starts | ✅ |

**Document contents are S (agreed, built in phase 2).** Phase 1 is for important
paperwork (certificates, ID scans), and today a copy of `/data` reveals all
of it. In phase 2, once the server key exists:

- New uploads are encrypted as they stream to disk, in fixed-size chunks
  (AES-256-GCM per chunk, each bound to the file's ID and chunk number), so
  large files never need to fit in memory and downloads and previews can
  still stream.
- A one-off migration encrypts every existing document and recycle-bin file
  in place, then removes the plain copies. It can be interrupted and
  resumed safely. Old plain blocks may linger in free disk space until
  overwritten, and backups made before the upgrade still hold plain copies.
- Backups of `/data` can then only be opened with the server key, so the
  backup and restore instructions name the key as a required part of a
  restore, kept separately (the owner's password manager).
- File and folder **names stay P**, so the server can list, sort and search
  them in the database. A name such as "Sam passport.pdf" reveals little;
  moving names to S later is cheap if wanted.

### The family vault (phase 2)

| Data | Where | Tier | Status |
|---|---|---|---|
| The family key | Only in memory on an unlocked parent device; never sent in the clear | E2E | ✅ |
| Wrapped copies of the family key (recovery, each passkey, each phone) | `vault_keys.wrapped` | E2E (each is the family key encrypted under a key the server never has: the recovery key, a passkey's PRF secret, a phone's keystore key) | ✅ |
| Vault check value | `settings` (`vault`) | E2E (a known text under the family key) | ✅ |
| Which parent has which passkeys and phones, their labels, passkey credential IDs and PRF salts | `vault_keys` | P (none of these opens anything alone) | ✅ |
| Pairing requests: the new device's one-time public key, its label, and the approval (the family key encrypted to that public key) | `vault_pairings`, deleted on delivery or after 10 minutes | P; the approval is E2E | ✅ |
| Phone's vault key | Android Keystore on the phone, usable 30 s after a strong biometric check | Never leaves the hardware | ✅ |
| Vault events (set up, opened, method added or removed, recovery used, pairing requested and approved) | `audit_log` | P | ✅ |

The recovery key itself is never stored anywhere but the owner's password
manager.

### Quick Info (phase 2)

| Data | Where | Tier | Status |
|---|---|---|---|
| Personal details: legal name, SA ID number, date of birth, SARS tax number | `quick_info.ciphertext` | E2E (family key; bound to the record's kind and person) | ✅ |
| Medical aid: scheme, plan, membership number, main member, dependant code | `quick_info.ciphertext` | E2E | ✅ |
| Household street and postal addresses | `quick_info.ciphertext` | E2E | ✅ |
| Passport numbers and expiry, vehicles (registration, VIN, licence expiry), insurance policies | `quick_info.ciphertext` | E2E | ✅ |
| Links to documents (file IDs and names) | `quick_info.ciphertext` | E2E | ✅ |
| Which person a record belongs to, its kind, version, when and by whom it changed | `quick_info` columns | P (the server needs it to list, sync and refuse clashing edits) | ✅ |
| People in Quick Info (names; a link to their account if they have one), including children without accounts | `family_profiles` | P (names appear across the hub) | ✅ |
| Quick Info events (person added or removed, record added, updated or deleted; never values) | `audit_log` | P | ✅ |
| Values shown or copied on a device | Screen and clipboard only | Masked until tapped; copied sensitive values cleared from the clipboard after 30 s | ✅ |

Linked documents themselves live in shared Files (tier S), which every
family member can open; the link, not the document, is E2E. The page says so
when linking.

### Family Contacts (phase 2)

| Data | Where | Tier | Status |
|---|---|---|---|
| Names, organisations, roles, categories, phone numbers, emails, addresses, notes | `contacts.sealed` (one value per contact, bound to its ID) | S (allows CardDAV sync later) | ✅ |
| Contact IDs, versions, when and by whom changed | `contacts` columns | P | ✅ |
| Emergency contacts (first call, if no answer) for each person | `family_profiles.emergency` (bound to the person) | S | ✅ |
| Links from Quick Info records to contacts (scheme, insurer) | Inside the Quick Info record | E2E | ✅ |
| vCard exports | Downloaded to the parent's device; notes left out unless chosen | Plain file on the device | ✅ |
| Contact events (added, updated, removed, exported, emergency contacts set; never details) | `audit_log` | P | ✅ |

### Notifications (phase 2)

| Data | Where | Tier | Status |
|---|---|---|---|
| Reminder records: what, whose, when (Quick Info expiry dates; created by the parent's device, as the server cannot read the record) | `reminders` (title, person, date) | P (the server sends them) | ✅ |
| Push addresses (UnifiedPush and Web Push endpoints) and their keys | `push_subscriptions.sealed` (bound to its ID) | S | ✅ |
| A fingerprint of each push address, to recognise a browser registering again | `push_subscriptions.endpoint_hash` (SHA-256) | H | ✅ |
| Push health: last success, failure count, when a route stopped working, the last error | `push_subscriptions` columns | P | ✅ |
| Device name for each push route ("Chrome on Windows") | `push_subscriptions.label` | P | ✅ |
| Which reminders were sent to which person | `reminder_deliveries` | P (IDs and times only) | ✅ |
| Notification settings per person (which reminders, from what hour) | `notification_settings` | P | ✅ |
| The hub's push signing key (VAPID private key) | `settings` | S | ✅ |
| The hub's https address, when learnt from a browser | `settings` | P | ✅ |
| Background-check tokens (read the owner's due reminders, as generic text, and nothing else) | `check_tokens.token_hash` (one per phone; removed with the phone) | H | ✅ |
| When each phone last checked | `check_tokens.last_check_at` | P | ✅ |
| The phone's copy of its check token and the hub's address | App-private storage on the phone (not backed up) | Plain on the phone; the token can only read generic reminder text | ✅ |
| The phone's UnifiedPush keys (to decrypt messages) | The UnifiedPush library's storage on the phone | Plain on the phone, app-private | ✅ |
| Reminders shown on the phone | Android notification (generic text; hidden on a locked screen), and the tags already shown, so each shows once | On the phone; tags only | ✅ |
| Notification text | Sent to the push service | Encrypted to the device (RFC 8291), so the push service (ntfy, Google, Mozilla, Apple) cannot read it; generic wording only | ✅ |

### People and dates, a family CRM (phase 3; agreed, being built)

| Data | Where | Tier | Status |
|---|---|---|---|
| Relationships between contacts (partner, child, parent, friend, custom label) | `contact_relations.sealed` (one value per relationship, holding both contact IDs, bound to its ID) | S | ✅ |
| Important dates: birthdays, anniversaries, memorials, custom dates (year optional), their reminder choices and which parent they are for; whether someone has passed away | Inside the sealed contact | S | ✅ |
| About them: how we met, interests, food preferences and allergies, clothing sizes | Inside the sealed contact | S | ✅ |
| Notes, timeline entries and life events | One sealed value per entry, bound to the contact | S | 🔜 |
| Stay-in-touch interval and last-contacted date | Inside the sealed contact | S | 🔜 |
| Gift ideas and gifts given | One sealed value per gift, bound to the contact | S | 🔜 |
| Group names and members | Sealed | S | 🔜 |
| Link from a contact to a Quick Info person | `contacts.profile_id` (both are IDs) | P | ✅ |
| Reminders for these dates | **Not stored.** The server works them out from the sealed contacts when it checks; only delivery records (IDs and times) are kept | P (IDs only) | ✅ |
| Notification text | Always generic, never a name or date: a few rotating variations such as "Tap to see whose birthday is coming up", "Someone's birthday is coming up. Tap to see who." and "An anniversary is coming up. Tap to see whose." No option to show names on the lock screen | Encrypted to the device (RFC 8291) | ✅ |
| vCard and calendar (`.ics`) exports, address-label CSV | Downloaded to the parent's device; notes and gift ideas left out unless chosen | Plain file on the device | 🔜 |
| vCard imports | Read in memory, shown for review, then discarded | Not stored | 🔜 |
| CRM events (person, note or date added or changed, relationship added or removed, import, export; never details) | `audit_log` | P | ✅ (3a) |

Reminders for these dates are deliberately not copied into the plain
reminder records used for Quick Info: a list of names with birthdays is
exactly what identity thieves look for, and the server can read the sealed
contacts anyway.

### Later phases (proposed; confirm at the start of each phase)

| Phase | Data | Proposed tier | Why |
|---|---|---|---|
| 4 Calendar | Events, locations, notes | S | Calendar sync (iCal feeds, maybe CalDAV) needs the server to read them. |
| 5 Lists, chores, noticeboard | Items, chores, notices | P | Everyday and low-risk; live sync is simpler. |
| 6 Meals | Plans, recipes | P | Not personal. Allergies come from Health, not stored here. |
| 7 Household admin | Bills, amounts, budgets | S | Financial, but the server must send due-date reminders. |
| 7 Household admin | Bank account or card numbers | E2E, or don't store at all | Fraud risk. |
| 7 Home & car | Service history, warranties | P or S | Low risk; decide with the phase. |
| 8 Health | Allergies, conditions, medications, history, treatment plans | E2E | Health data; already agreed. |
| 8 Health | Repeat-prescription reminders | P (what · whose · when only) | Same split as Quick Info reminders. |
| 8 Health | Offline emergency card on the phone | E2E, opened by biometric | Already agreed. |
| 9 Wishlists | A family member's own wishlist, and ideas others add for them | S | Hidden from the recipient by access rules, not encryption. (Gift ideas for friends and family are in phase 3.) |
| 9 In case of emergency | Instructions for a trusted person | ❓ | Released after a waiting period, which needs either server access (S) or key escrow to the trusted person (E2E). Decide with the phase. |

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
