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
| People in Quick Info (names; a link to their account if they have one), including children without accounts. Everyone with an account gets one when the wishlists are first opened (8a) | `family_profiles` | P (names appear across the hub) | ✅ |
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

### People and dates, a family CRM (phase 3)

| Data | Where | Tier | Status |
|---|---|---|---|
| Relationships between contacts (partner, child, parent, friend, custom label) | `contact_relations.sealed` (one value per relationship, holding both contact IDs, bound to its ID) | S | ✅ |
| Important dates: birthdays, anniversaries, memorials, custom dates (year optional), their reminder choices and which parent they are for; whether someone has passed away | Inside the sealed contact | S | ✅ |
| About them: how we met, interests, food preferences and allergies, clothing sizes | Inside the sealed contact | S | ✅ |
| Notes, timeline entries, life events and times you were in touch | `contact_notes.sealed` (one value per entry, bound to the contact and entry ID); entry IDs, contact and times in plain | S | ✅ |
| Stay-in-touch interval, when it was set, last-contacted date and who is reminded | Inside the sealed contact | S | ✅ |
| Gift ideas and gifts given (idea, occasion, link, when given) | `contact_gifts.sealed` (one value per gift, bound to the contact and gift ID) | S | ✅ |
| Group names (`contact_groups.sealed`, bound to the group ID) and who is in each (inside each sealed contact) | Sealed | S | ✅ |
| Link from a contact to a Quick Info person | `contacts.profile_id` (both are IDs) | P | ✅ |
| Reminders for these dates | **Not stored.** The server works them out from the sealed contacts when it checks; only delivery records (IDs and times) are kept | P (IDs only) | ✅ |
| Notification text | Always generic, never a name or date: a few rotating variations such as "Tap to see whose birthday is coming up", "Someone's birthday is coming up. Tap to see who." and "An anniversary is coming up. Tap to see whose." No option to show names on the lock screen | Encrypted to the device (RFC 8291) | ✅ |
| vCard and calendar (`.ics`) exports, address-label CSV | Downloaded to the parent's device; shared notes left out unless chosen; timeline notes and gift ideas never exported | Plain file on the device | ✅ |
| vCard imports | Read in memory for the preview, then discarded; only the people the parent chooses are saved (as sealed contacts) | Not stored | ✅ |
| CRM events (person, note, gift or date added or changed, relationship added or removed, "we spoke", import, export; never details) | `audit_log` | P | ✅ |

Reminders for these dates are deliberately not copied into the plain
reminder records used for Quick Info: a list of names with birthdays is
exactly what identity thieves look for, and the server can read the sealed
contacts anyway.

### Family calendar (phase 4)

The public-holiday setting (on or off) is a plain setting. Holidays are worked out on the server; nothing is fetched for them.

| Data | Where | Tier | Status |
|---|---|---|---|
| Events: title, start and end, all-day, repeat rule and changed or cancelled days, tags (people or Family), location, notes, links to a contact and a file (with the file's name), reminder choices | `events.sealed`: one value per event, bound to its ID (times included, so routines cannot be read from the database) | S | ✅ (reminders: 4b) |
| Event IDs, versions, when and by whom changed | `events` columns | P | ✅ |
| Each person's colour | `family_profiles.colour` | P | ✅ |
| Reminders for events | **Not stored.** Worked out from the sealed events every minute; only delivery records (IDs and times) are kept | P (IDs only) | ✅ |
| Reminder notification text | Generic ("An event starts in 1 hour. Tap to see."), encrypted to the device | RFC 8291 | ✅ |
| Birthdays on the calendar | Read from Contacts each time; never copied; name, day and age only, for everyone in the family | (Contacts' tiers) | ✅ |
| Family members kept on a contact (e.g. a friend's young child: name, birthday, reminder, and which other contact they are shown under) | Inside the parent contact's sealed value | S | ✅ |
| Subscription links, names, default tags and "always accept" | `calendar_subscriptions.sealed`, one per subscription, bound to its ID | S (links can contain secret tokens) | ✅ |
| Events fetched from subscriptions or imports, waiting in the inbox | `calendar_inbox.sealed` per item, bound to its ID; cleared after 30 days | S | ✅ |
| Which outside events were accepted or ignored | `calendar_links`: a hash of the source's event ID, a hash of its contents (to spot changes), the accepted event's ID | H / P | ✅ |
| Subscription health: last fetched, last success, last error | `calendar_subscriptions` columns | P | ✅ |
| `.ics` exports (one event, or a date range for everyone, Family or one person) | Downloaded to the person's device; notes left out unless chosen | Plain file on the device | ✅ |
| `.ics` imports | Read in memory into the inbox (sealed); the file is not kept | Not stored | ✅ |
| Calendar events (added, changed, removed, exported, imported, subscriptions added or removed with the calendar's host name; never details) | `audit_log` | P | ✅ |

Nothing outside the hub reads the calendar live (no iCal feed or CalDAV):
exports are files a person chooses to send, so two-factor sign-in remains
the only way in.

### Health (phase 5)

| Data | Where | Tier | Status |
|---|---|---|---|
| Allergies, conditions, blood type, care notes, medicines and their changes, providers and their roles, history entries, vaccinations, growth measurements, appointments, episodes and every entry in them (observations, doses, vitals, doctors' notes, tests), medicine plans | One encrypted record per item, bound to its person (`health_records.ciphertext`) | E2E (family key) | ✅ (summary, allergies, conditions, providers, medicines, history, vaccinations, growth, check-ups, appointments, episodes) |
| Which person a health record is for, when and by whom it changed, its version | `health_records` columns (the kind of record is inside the encryption) | P | ✅ |
| Health documents (results, scripts, X-rays, photos) | Files, in a Health folder only parents can open (`files.parents_only`; the server hides it, and all in it, from members everywhere) | S (server key), over https | ✅ |
| Health reminders (prescriptions, script expiry, follow-ups, vaccinations due, measuring, check-ups, episode doses) | Reminder records holding only "health reminder · person · date", how many days ahead, and an opaque key (a hash; it says nothing about what the reminder is for) | P (the server sends them) | ✅ |
| Reminder notification text | Generic ("A health reminder is due.", "A medicine is due.") | Encrypted to the device (RFC 8291) | ✅ |
| Appointments on the family calendar | A calendar event the parent chooses: "Appointment – Sam" by default, "Dr Naidoo – Sam", or none (then a health reminder) | S (calendar) | ✅ |
| Emergency card on each parent's phone (allergies, conditions, medicines, blood type, care notes, ID number, emergency contacts, medical aid) | In the app's storage on the phone, sealed with AES-GCM under a fresh key that is itself sealed to an RSA key pair in the Android Keystore. Updating it needs no fingerprint (the public key); opening it needs a fingerprint or face check (the private key never leaves the keystore). Only "last updated" is readable without it. Removed when the phone is signed out; destroyed if the phone's fingerprints or face change | E2E on the device | ✅ |
| PDF summaries and episode reports | Made on the device; saved or shared only where the parent chooses (on the phone, through the app's cache, cleared when the app locks). The server records only that a report of a kind was made | Plain file on the device | ✅ |
| Episode entries made offline (later) | Kept on the phone, encrypted with the family key, until sent | E2E | 🔜 (later) |
| Health events (record added, changed or removed; report made; never details) | `audit_log` | P | ✅ (5a) |

The server never learns what kind of health record something is: a stolen
database shows at most how many records each person has. Reminders reveal
only that a health reminder for that person is due at a time (the owner
chose this over phone-only dose alarms so reminders also work in browsers).

### Household admin (phase 6)

The owner chose the server key (S) for money: the server works out reminders
and totals itself, and nothing here is an account number, card number or bank
login (those are never stored). Each sealed item is bound to its own ID.

| Data | Where | Tier | Status |
|---|---|---|---|
| Accounts: bank name and a nickname ("Capitec, joint"). Never account or card numbers | One sealed record per account | S | ✅ |
| Bills and subscriptions: payee (name or Contacts link), category, amount, how often, due day, how paid, which account, contract dates, notice period, trial end, review date, who uses it, how to cancel, notes | One sealed record per bill | S | ✅ |
| Price history and payments made (date, amount, marked by whom) | Inside the bill's sealed record, or one sealed record per payment | S | ✅ |
| Invoices: from whom, invoice number, dates, amount, status, notes, what it belongs to | One sealed record per invoice | S | ✅ |
| Invoices, receipts, warranties, manuals and service invoices (the files) | Files, in a Household folder only parents can open (like the Health folder) | S, over https | ✅ |
| Vehicles: a nickname chosen by the parents, service intervals, odometer readings, roadworthy, warranty and service-plan dates, tyres, battery (registration, VIN and licence disc stay in Quick Info, E2E, and are never copied here) | One sealed record per vehicle in `home_care`, linked to the Quick Info vehicle by its ID | S | ✅ |
| Home items with warranties (what, make, model, serial number, where bought, price, dates), recurring maintenance and when last done, jobs (what, for which, who, cost, odometer, "would use again" and why, invoice link, notes) | One sealed record per item in `home_care` | S | ✅ |
| The budget: categories (order, group, saves up, opening balances), each month's income and lines, money moved between categories; planned expenses (what, amount, month, saving from, for whom, tag) | One sealed record per month (`budget`, keyed by the month, which is plain), one for the categories, one per planned expense | S | ✅ |
| Transactions: date, description, amount, account, category, "transfer" mark, note | One sealed record per transaction (`transactions`); only its month is plain, to read one month at a time | S | ✅ |
| A fingerprint of each transaction, to skip ones already imported | `transactions.fingerprint`: HMAC-SHA-256 with a key derived from the server key, of the account, date, amount, description and its place among identical ones in the export | H | ✅ |
| The bank's CSV file | Read on the parent's device only; never uploaded or kept | Not stored | ✅ |
| Import formats: a name, the header row's column names, which column is which, date style, decimal mark | `import_formats`, one row per layout (holds no personal data) | P | ✅ |
| Categorising rules ("WOOLWORTHS" → Groceries): they reveal where the family shops | One sealed record per rule (`budget`) | S | ✅ |
| Debts (not the home loan): name, kind, balance and its history, interest rate, minimum payment, paid-off date; milestones (emergency-fund target, months, extra for debt, ticks and notes) | One sealed record per debt; one for the milestones | S | ✅ |
| Household reminders (bill due, overdue, notice deadline, trial ending, review, invoice due, vehicle service and roadworthy due, maintenance due, warranty ending, plan next month's budget from the 25th once the budget is in use) | Worked out by the server from the sealed items each time; nothing extra is stored except the delivery record (the item's ID, the date and how far ahead), so each is sent once | P (delivery records) | ✅ |
| Reminder notification text | Generic ("A bill is due. Tap to see.", "A renewal deadline is coming up.", "A free trial ends soon.", "An invoice is overdue.", "A vehicle service is due soon.", "A roadworthy is due soon.", "Home maintenance is due.", "A warranty ends soon.", "Time to plan next month’s budget.") | Encrypted to the device (RFC 8291) | ✅ |
| Household events (added, changed, removed with the kind of item; later imports with counts; never details) | `audit_log` | P | ✅ |

### School hub (phase 7)

| Data | Where | Tier | Status |
|---|---|---|---|
| Each child's school years (school, grade or class, terms and their dates, the fees bill, notes); school contacts (a Contacts link, role, note, for one child or all); extra-murals (activity, who runs it, Contacts links, where, days and times, dates and term, number to cancel or postpone, cost, links to a bill, invoice or planned expense, the calendar events); reminders (what, date, how far ahead, notes, done) | One sealed record per item in `school`; plain: the kind of item and which child (none for "all children") | S | ✅ |
| Forms and permission slips (what, what it needs, amount, deadline, the form's documents, done and when); uniform, stationery, kit and "what to bring" lists (items, how many, bought, the day) | One sealed record per item in `school` | S | ✅ |
| Timetable (lessons by day and time), homework, projects and tests (subject, what, due, done, notes) | One sealed record per item in `school` | S | ✅ |
| School dates | Calendar events tagged to the child (phase 4 rows); the extra-murals' weekly events too | S | ✅ |
| Fees and school costs | Bills and planned expenses (phase 6 rows), tagged "school" and the child | S | ✅ |
| Reports, letters and forms (the files) | Files, in a School folder with a folder per child; parents-only to start (the children's own access decided with kids' accounts) | S, over https | ✅ |
| Reminders (things to plan for or take to school; form deadlines) | Worked out from the sealed items; delivery records only; generic text ("A school reminder is due. Tap to see.", "A school form is due. Tap to see.", "School work is due. Tap to see.", "A school test is coming up. Tap to see.") | P (delivery records) | ✅ |

### Wishlists and the gift planner (phase 8; built)

| Data | Where | Tier | Status |
|---|---|---|---|
| Wishlist items: what, link, rough price, how much wanted, size or colour, notes, received | `wishlist` (kind item), one sealed record per item bound to its ID, with whose list it is (a profile ID) | S | ✅ 8a |
| "I'm getting this": who, for shared gifts how much, and a note | `wishlist_claims`, one sealed record per claim bound to its ID, with the item and the claimer's account; never sent to the list's owner (the server leaves claims out of everything it sends them) | S, hidden by access rules | ✅ 8a |
| Share links for a child's wishlist | `wishlist_links`: a random 256-bit token, kept only as a SHA-256 hash (shown to the parent once, when made); whose list, who made it, when, when turned off. A new link turns the old one off | H (the token), P (the rest) | ✅ 8b |
| What a share-link visitor enters (their name, what they are getting, their share, a note) | `wishlist_claims`, sealed like the family's own claims, with the link it came through and a hash of the secret that lets that browser take it back. Visitors see whether a wish is taken and how much is pledged, never names | S (claim), H (undo secret) | ✅ 8b |
| Sizes card per family member | `wishlist` (kind sizes), one sealed record per person | S | ✅ 8a |
| Gift planner: status of each idea (idea, bought, wrapped, given), amount, the day it is for, link to a planned expense | Inside the sealed Contacts gift idea (`contact_gifts.sealed`, phase 3 row); the occasions are worked out each time from the sealed contacts and never stored; the planned expense is the budget's own sealed record | S | ✅ 8c |

### In case of emergency (phase 9; built)

| Data | Where | Tier | Status |
|---|---|---|---|
| Trusted parties: name, email, role (guardian or to inform), who they are, phone, notes | `trusted_parties`, one sealed record per party bound to its ID | S | ✅ 9a |
| The parents' written instructions | `emergency_secrets` (instructions): sealed on a parent's device with the family key, bound to what it is; the server keeps only the ciphertext | E2E (family key) | ✅ 9b |
| The pack: a PDF of the instructions and what the hub knows (health summaries, IDs, medical aid, contacts, school, policies, bills, documents list) | Made on a parent's device when the vault is open, locked there with the letter's password (PDF AES-256); the server stores only the locked file (`emergency_pack`, refused unless it is locked with AES-256) and cannot open it; made again at most daily while a parent's vault is open | E2E (the letter's password) | ✅ 9b |
| The pack's password (the letters' password) | In the parents' password manager and the guardians' letters; on the hub only as `emergency_secrets` (password), sealed with the family key on a parent's device, so the pack can be remade whenever the vault is open. The server cannot read it. (Was "not stored" in 9a; moved to end-to-end encrypted with the owner's agreement, so the pack stays up to date.) | E2E (family key) | ✅ 9b |
| Request links, one per trusted party | `trusted_parties.request_hash`: a random 256-bit token kept as a SHA-256 hash, shown once when the letter is made (a new letter replaces it); when the last letter was made | H (the link), P (when) | ✅ 9a |
| Release settings (waiting periods, check-in timing) and the state of a request or check-in (started when, stage, next step, check-ins sent, how it ended) | `settings` (emergency_settings) and `emergency_release`; the party is a link to their sealed record; a requester's note is sealed | P (settings, times), S (who, the note) | ✅ 9c |
| Last activity of either parent (for the inactivity backstop) | Worked out from the parents' sessions (last seen), with the latest kept in `settings` so expiring sessions do not forget it | P | ✅ 9c |
| The email account the hub sends from (address, server, app password) | The server's environment, or a password file (a Docker secret); never in the database or the repository. Mail is sent only over TLS (plain SMTP only to the same machine) | Configuration | ✅ 9a |
| Emails sent (to trusted parties and parents) | Plain text with no details beyond names and dates; the pack attached locked; a pointer to the password ("in the letter"), never the password | Sent over TLS to the mail server | ✅ 9c |
| When the pack was made, by whom, its size and when it was last downloaded (for the yearly reminder to print a fresh copy) | `emergency_pack` | P | ✅ 9b |
| The list of documents in the pack (names and folders) | Read from Files on the parent's device for the pack; nothing new stored | (pack) | ✅ 9b |
| Each parent's email for warnings (a request, the second check, check-ins) | `emergency_parent_email`, sealed with the server key, bound to the parent | S | ✅ 9c |
| "Is all well?" links in the emails to trusted parties (backstop) | `emergency_asks`: a random token per party per release, kept as a hash | H | ✅ 9c |
| A test email from Settings → In case of emergency | Sent to the address the parent types, which is not kept; it says only that the hub can send email | Sent over TLS to the mail server | ✅ 9a |
| Emergency events (someone added, changed or removed with their role, a letter made, a test email sent or failed; never names or addresses) | `audit_log` | P | ✅ 9a |

### Safety: home safe, arrived and SOS (phase 10; planning)

Everyone with an account in the family is told; nobody outside it.

| Data | Where | Tier | Status |
|---|---|---|---|
| Check-ins (home safe, arrived): who, when, an optional word on where | `safety_checkins`, one sealed record per check-in bound to its ID; the whole check-in is deleted after 24 hours | S, deleted after 24 hours | ✅ 10a |
| Location shared with "Arrived" (coordinates to 6 decimals and accuracy in metres) | Sealed with the check-in; deleted with it after 24 hours. Taken on the device when "Arrived" is tapped (Android's location service, or the browser's), never in the background | S, deleted after 24 hours | ✅ 10a |
| SOS: who, when, the track of locations (coordinates, accuracy, time taken, battery low or not), how it ended and the reason given | `safety_sos` and `safety_sos_points`, each point sealed and bound to its SOS; the end sealed; all deleted 24 hours after the SOS ends (one left running ends itself after a day with no location) | S, deleted after 24 hours | ✅ 10b |
| Locations waiting on the phone with no connection | A file in the app's private storage on that phone (`sos-queue.json`; backups are off), removed as they are sent and when the SOS ends | On the device | ✅ 10b |
| Notification text | "Jo is home safe.", "Jo arrived.", "SOS from Jo. Tap to see." (names are wanted: they go only to the family). Home safe and Arrived can be turned off per person in Settings → Notifications; SOS cannot | Encrypted to the device (RFC 8291) | ✅ 10a, 10b (SOS comes whatever the settings) |
| The SOS pass: lets the phone send locations for that one SOS, and end it, once the app has locked | Given to the phone when the SOS starts (in the unlocked app); kept in the phone's memory and the service's start request; the server keeps a SHA-256 hash; useless once the SOS ends | H | ✅ 10b |
| The family's phone numbers, for the SMS fallback | Kept on each phone in the app's storage, encrypted with a key in the phone's keystore, refreshed when the app opens (from the family's own Contacts entries) | On the device (keystore) | 🔜 10c |
| SMS sent with no data: "SOS from Jo", coordinates and a Google Maps link | Sent by the phone over the mobile network; not encrypted (SMS cannot be) | Plain, to the family's phones only | 🔜 10c |
| Emergency contact and medical details on the SOS screen | A copy of the phone's offline emergency card (phase 5d) kept for the SOS screen only, encrypted with a keystore key that needs **no fingerprint** (the owner's choice), so it shows at once, also from the lock screen. Anyone holding the phone can see it by starting an SOS (which alerts the family) | On the device (keystore, no fingerprint) | 🔜 10c |
| The SOS key: lets a locked phone start an SOS, send its locations and end it, and nothing else | A second non-exportable keystore key per phone, usable without a fingerprint; the server keeps its public key and refuses it for anything but SOS | On the device (keystore); public key P | 🔜 10c |
| A tap on "Open in Google Maps" | Google learns the coordinates of that one location, only when someone taps it | Google | ✅ 10a |

### Later phases (proposed; confirm at the start of each phase)

| Phase | Data | Proposed tier | Why |
|---|---|---|---|
| 11 Lists, chores, noticeboard | Items, chores, notices | S suggested (was P) | Posts and to-dos can hold things like "key under the mat"; decide with the phase. |
| 12 Meals | Plans, recipes | P | Not personal. Allergies come from Health, not stored here. |
| Later: home loan | Balance, rate, extra payments | S (as the other debts) | Decide with the feature. |

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
