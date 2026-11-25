# Family Hub — roadmap

The plan for building Family Hub in phases, and the hand-over document for
work in a fresh session: what exists, what is next, and what was decided.
**Tick items off here in the pull request that lands them.**

Each phase is one or more pull requests into `main`, and usually ends in a
release (`release: minor`). The order after phase 1 is a proposal: reorder
freely. (On 23 November 2026 the owner moved Health and Household admin
ahead of lists and meals.) Routine upkeep has its own procedure in [MAINTENANCE.md](MAINTENANCE.md);
the security model is in [SECURITY.md](SECURITY.md). **Each phase starts by
deciding how its data is protected** in
[DATA-PROTECTION.md](DATA-PROTECTION.md), before any code.

## Architecture (decided)

| Piece | Location | Stack |
|---|---|---|
| Server | `apps/server` | Node 24 `node:http` + `node:sqlite`, built-in Argon2id, **no npm dependencies**. Runs its TypeScript directly (type stripping). Numbered schema migrations in `src/db.ts`. |
| Shared interface | `packages/ui` | React 19, `lucide-react` icons, plain CSS with light/dark tokens (`styles.css`). Talks to the server only through `Api` (`api.ts`). Each module is an entry in `modules.ts` and a page under `pages/`. |
| Web app | `apps/web` | Vite build of the shared interface, served by the server with a strict CSP. Cookie sessions. |
| Android app | `apps/mobile` | Capacitor 8 shell around the same interface, hash routing, bearer sessions unlocked by a biometric-bound keystore key (`DeviceAuthPlugin.java`), in-app updates from GitHub releases (`AppUpdatePlugin.java`). Android 11+. |
| Delivery | `.github/workflows` | CI on every PR; `release: *` labels release a signed APK and a multi-arch image to `ghcr.io/deanbirnie/family-hub`; weekly cleanup; Dependabot; a weekly Claude maintenance run. |

Decisions worth knowing before changing things:

- **Two-factor on the web and biometrics on Android are mandatory** and
  enforced by the server, not just the interface. No "remember this browser"
  that skips the code; no PIN fallback for the phone key.
- **Invite-only.** No open registration, ever.
- **Data stays at home.** No third-party services in the request path (the
  only outbound call is the Android app checking GitHub for updates). Anything
  that would need one (push notifications, maps, recipe import) must be
  optional and self-hostable.
- **New modules plug in the same way:** a migration in `db.ts`, a route file
  in `apps/server/src/routes/`, a page in `packages/ui/src/pages/`, its entry
  in `modules.ts` moved from `planned` to `ready`, tests at each level.

## Phase 0 — Foundation ✅ (this pull request)

- [x] Monorepo: server, shared interface, web app, Android app
- [x] First-run setup (family name + admin), invite-only members, roles (admin / member)
- [x] Mandatory TOTP two-factor with recovery codes; account lockout and rate limits
- [x] Android: device registration with a hardware-keystore ECDSA key, biometric unlock on every open, auto-lock, `FLAG_SECURE`
- [x] Sessions list, phones list, password change, security activity log
- [x] Admin tools: roles, turn accounts off, reset a member's two-factor
- [x] Base UI: sidebar / bottom-bar shell, home page with all planned modules, light and dark
- [x] Docker image (non-root, no package managers), `docker-compose.yml`
- [x] CI: typecheck, unit tests, web and mobile e2e, image build + health check + scan, debug APK + library scan, actionlint/shellcheck
- [x] Releases by label: signed APK on GitHub releases + image on ghcr.io; in-app update notification and install
- [x] Maintenance: Dependabot, weekly cleanup, weekly Claude maintenance run (`docs/MAINTENANCE.md`)

## Phase 1 — Shared family documents ✅

One shared folder on the home server gives every signed-in family member
quick access to important documents, PDFs and occasional reference images
such as scans or photos of paperwork. Immich handles family photo and media
libraries and backups.

- [x] **Shared access:** one Family folder for all members, available in the
      browser and Android app. All members can browse, upload and download.
- [x] **Organise:** create subfolders, search by filename, and rename, move
      or delete files.
- [x] **View:** preview PDFs and common image formats in the app, and
      download other documents to open them.
- [x] **Recover:** keep deleted documents for 30 days and document how to
      back up and restore the shared folder alongside the hub database.

## Phase 2 — Quick Info, Family Contacts and notifications ✅

Family Hub initially supports parents managing family administration.
**Parents are the family's admins** (the interface calls the role
"Parent"). Either parent can view and edit all records in Quick Info,
Family Contacts and later Health, including their own, the other parent's
and each child's; members see none of them. Family profiles can exist
without login accounts. Access for other family members comes later, when
their permissions can be defined. The server enforces all of this.

### Design (agreed)

**Two keys, for two kinds of data.** The full register of what is stored
under which, for this and every later phase, is
[DATA-PROTECTION.md](DATA-PROTECTION.md).

| Key | Protects | Who can decrypt |
|---|---|---|
| **Family key** (end-to-end) | Quick Info, and Health in phase 5 | Only parents' unlocked devices. The server stores ciphertext and never sees the key. |
| **Server key** (at rest) | Family Contacts, authenticator (TOTP) secrets, reminder delivery addresses | The server. A key file outside the database volume, so a copied database or backup alone reveals nothing. |

Contacts use the server key on purpose: they are shared between parents and
synced, and a later CardDAV option (the phone's own contacts app syncing the
family address book) needs the server to read them.

**The family key, end to end.**

- A random 256-bit key encrypts each Quick Info record (AES-256-GCM, with the
  record ID as associated data) in the browser or app before it is sent.
- Each parent has an ECDH key pair. The family key is shared with a parent by
  encrypting it to their public key. The first parent creates the family key;
  the second receives it from the first parent's unlocked device.
- **Recovery kit:** when the family key is created, the app shows a recovery
  key to keep in a password manager (the owner's plan). The recovery key
  alone can restore access on a new device. **If every parent loses every
  device and the recovery key, Quick Info cannot be recovered by anyone**,
  including the server's owner.
- The server can see which person a record belongs to, its type and when it
  changed; never the values.

**Unlocking, once per session; never with a password alone.**

- **Android:** the family key is wrapped by a hardware-keystore key that
  needs a strong fingerprint or face check. The check that opens the app
  unlocks it too: no extra prompt. The app already locks after 2 minutes in
  the background.
- **Browser**, in order of preference:
  1. **Passkey** (Windows Hello, Touch ID, a phone or a security key), using
     the WebAuthn PRF extension to unwrap the family key. One touch.
  2. **Approve with your phone:** the browser shows a QR code; the parent
     scans it in the Family Hub app and confirms with their fingerprint; the
     phone sends the family key, encrypted to that browser tab's one-time key.
     Works in browsers without passkey support.
  - A passphrase-plus-fresh-code fallback was considered and left out: the
    two options above cover every case, without another passphrase.
- In the browser the key lives only in the tab's memory, and the vault locks
  after **15 minutes unused** or when the tab closes.
- Sensitive fields stay masked against shoulder-surfing; showing one is a
  tap, with no further check. Copied values are cleared from the clipboard
  after 30 seconds. The audit log records each vault unlock (the server
  cannot see individual reveals, as decryption happens on the device).

**Notifications: user-chosen push, with a fallback that always works.**

- **Android:** UnifiedPush, so each phone uses the push service its owner
  chooses: ntfy (the goal; the public ntfy.sh needs no server, a self-hosted
  ntfy can replace it later), NextPush, Sunup or any other distributor.
  Needs the `org.unifiedpush.android:connector` library (agreed).
- **Fallback, always on:** every phone also checks for due reminders once a
  day in the background (Android's job scheduler, whenever the phone has a
  network),
  whether or not push is set up, and again whenever the app is opened. A
  reminder is shown once, by whichever route arrives first. If ntfy is down,
  misconfigured, uninstalled or never set up, reminders still arrive within
  about a day. Limits: the phone must be able to reach the hub (if it can
  only do so at home, it catches up when it is back), and Android's battery
  saving can move the check by a few hours.
- **Browser:** standard Web Push through the browser's own push service
  (not ntfy), for whoever turns it on.
- **Always in the app:** a "Coming up" card on the home page lists what is
  due, so nothing depends on a notification arriving at all.
- **Push health:** each phone and browser shows whether push is working,
  with a "Send a test notification" button. When a push service refuses or
  stops answering, the server marks that route as failing (Settings says
  so, and that the daily check is still on) and stops using an address the
  push service says is gone.
- Both push routes use RFC 8291 encryption, implemented with Node's built-in
  crypto (the server stays dependency-free), so the push service cannot read
  the notification. The server sends only to https addresses registered by a
  signed-in device.
- The background check uses a token that can only read reminder titles and
  dates, since the device key needs a fingerprint for every use.
- Notification text is generic ("A family document expires soon", "A
  birthday is coming up"); details show only inside the unlocked app.
- **Reminder records are not end-to-end encrypted:** saving a passport or
  licence date also saves a reminder holding only what, whose and when
  ("Passport renewal · Sam · 1 March 2027"), so the server can send it. The
  number itself stays encrypted. Phase 3 (people and dates) and later reuse
  this system.
- **Built for yearly dates too:** a reminder can repeat every year and can
  have a day and month without a year (a friend's birthday when you don't
  know the year), so phase 3 plugs straight in.

### Build order (one pull request each)

**1. Parents, keys and unlocking**

- [x] Admin role shown as "Parent". (Quick Info, Contacts and Health routes
      are limited to parents on the server as each is built.)
- [x] Server key file: created on first start, its location configurable
      and documented for backup; TOTP secrets moved under it (migration).
- [x] Shared document contents encrypted with the server key: streamed,
      chunked encryption for uploads, downloads and previews, and a
      resumable migration of existing files; backup and restore steps
      updated to include the key. (May land as its own pull request.)
- [x] Family key creation, the recovery kit, and sharing with the second
      parent.
- [x] Android: family key unwrapped by the same biometric check that opens
      the app.
- [x] Browser: passkey (WebAuthn PRF) unlock, and approval from another
      unlocked device (a code plus six check words, in place of a QR code,
      so it needs no camera and works phone↔browser either way).
- [x] Vault lock after 15 minutes unused; unlocks in the audit log.

**2. Quick Info**

A reference card per person and one household card for information needed
when filling in forms or handling family paperwork, all end-to-end encrypted.

- [x] **Family profiles**, including people without login accounts (children).
- [x] **Personal details:** full legal name, South African ID number and date
      of birth. Optional SARS income tax reference number for each adult.
- [x] **Medical aid:** scheme, plan, membership number, main member and each
      person's dependant code, and the scheme's contact from Family Contacts.
- [x] **Household details:** street address, including suburb and postal code,
      and postal address if different.
- [x] **Optional details:** passport number and expiry, vehicle registration
      and licence renewal date, and insurance policy number, with the insurer
      or broker from Family Contacts.
- [x] **Documents:** link scans and certificates from Shared Family Documents
      when suitable for everyone who can access the shared folder.
- [x] **Masked fields** with tap-to-show and copy that clears after 30 seconds.

**3. Family Contacts**

One shared address book for people and organisations the parents need to
reach, including family and friends, schools, healthcare practices, insurers
and tradespeople. Encrypted at rest with the server key.

- [x] **Contact cards:** name, organisation, role, phone numbers, email,
      address and a short shared note.
- [x] **Reusable links:** Quick Info records link contacts (Health and
      Calendar will too when they are built), so contact edits appear
      everywhere the record is used. Reuse these
      contacts in Household Admin when that phase is built.
- [x] **Emergency contacts:** designate a primary and backup contact for
      each family member.
- [x] **vCard export:** export one contact or the whole address book as a
      `.vcf` file. Include standard contact fields and omit internal notes
      by default.
- CardDAV (the phones' own contacts apps syncing the family address book)
  is planned in phase 3.

**4. Notifications and expiry reminders** (two pull requests: 4a server,
browser and home page; 4b Android)

- [x] Reminder records, created from Quick Info passport and vehicle licence
      dates (from 90 days before, then 30 and 7), including yearly and
      year-less dates for phase 3.
- [x] Browser: Web Push (RFC 8291, built-in crypto), with push health and a
      test button.
- [x] Notification settings per person, and a "Coming up" card on the home
      page for parents.
- [x] Android: UnifiedPush registration (ntfy and other distributors), and
      the always-on daily background check.

## Phase 3 — People and dates (a family CRM) ✅ (CardDAV later)

Family Contacts grows into a personal relationship manager for the people
the family cares about, in the spirit of open-source personal CRMs such as
Monica and Nametag: who is who, how they are related, the dates that matter
to them, and reminders so none are missed. Parents only, like Contacts, and
built on the same address book (no second list of people). Everything here
is encrypted with the server key, because the server has to read it to send
reminders, export it and, later, sync it.

**People and relationships**

- [x] **Relationships** between contacts, both ways: partner or spouse,
      child and parent, sibling, grandparent, friend, colleague, plus a
      custom label. A person's page shows their family ("Thandi's partner
      Sipho; their children Lwazi (7) and Ayanda (4)").
- [x] **Quick add a child or partner** from a person's page: just a name and
      a birthday, creating a linked contact without phone numbers. (Phase 4b
      changes "Add a child" to keep the child on the contact instead.)
- [x] **Groups:** e.g. "Book club", "School parents", "Christmas card list";
      filter and export by group.
- [x] **About them:** how we met, interests, food preferences and
      allergies (for hosting), and clothing and shoe sizes (for gifts,
      mainly children's).
- [x] **The family themselves:** link a contact to a Quick Info person, so
      the family's own birthdays and anniversaries appear here too without
      copying ID numbers out of the vault.

**Important dates**

- [x] **Birthdays, anniversaries and custom dates** (a memorial, a name day,
      "moved to Perth"). The year is optional: a day and month is enough.
      Age or years are shown when the year is known ("turns 40").
- [x] **Reminders for each date**, through the phase 2 notification system:
      by default a week before and on the day, adjustable per date, and
      chosen per parent (both, or just one of you). Marking someone as
      deceased stops birthday reminders; a memorial reminder is optional.
      The notification never names anyone: it is one of a few generic
      lines, such as "Tap to see whose birthday is coming up", and the
      details are in the app.
- [x] **Upcoming dates** on the home page "Coming up" card and a "This month"
      list on the Contacts page.

**Keeping in touch**

- [x] **Notes and a timeline per person:** dated entries ("Lunch at the
      Waterfront", "expecting a baby in May") and life events (new job,
      moved house, new baby, which can add the date for you).
- [x] **Stay in touch:** an optional "catch up every few weeks / months" per
      person, a "We spoke" button that records the last contact, and a
      reminder when it is overdue.
- [x] **Gift ideas and gifts given** per person and occasion, so you remember
      what you gave last year. (Moved here from the extras phase.)

**Getting data in and out**

- [x] **Import from vCard** (Google Contacts, the phone's contacts app,
      Monica's export), with a preview and duplicate matching before
      anything is saved. Imported files are read and discarded, not kept.
- [x] **vCard export** of a person, a group or everyone, including
      birthdays (with or without the year), anniversaries and related names,
      tested against Google Contacts, Android's contacts app and Apple
      Contacts (each handles year-less dates and relationships slightly
      differently, so the export uses the forms each one reads).
- [x] **Calendar export:** an `.ics` file of birthdays and anniversaries as
      yearly events, for any calendar app. The phase 4 private calendar
      feed then includes them automatically.
- [x] **Address labels:** export a group's postal addresses as CSV (the
      Christmas card list).
- [ ] Later: **CardDAV**, so the phone's own contacts app (and through it,
      the phone's calendar) syncs the family address book, birthdays
      included.

## Phase 4 — Family calendar ✅

The family's calendar lives **inside the hub only**. Events can be sent out
to Google Calendar, Outlook or a phone's calendar as files, but nothing
outside reads the hub's calendar live, so two-factor sign-in stays the only
way in. Agreed with the owner in the phase 4 planning pull request.

### Design (agreed)

**People and tags.**

- The calendar's people are the family: everyone with an account and the
  children without accounts (the same people as Quick Info, so there is one
  list). A parent gives each a **colour**.
- A **Family** tag (its own chip, with a house icon) marks what matters to
  everyone.
- Every event is tagged with one or more people, or Family. An event for
  several people shows each of their colours.

**Views.**

- **My view** (the default): my events and Family events.
- **A person's view:** tap their chip to see their events and Family events.
- **Everyone:** every event, colour-coded.
- Month, week and agenda (a list; the default on phones); filters by person.
- **Today** on the home page: each person's day, and the next few days.

**Who can do what.** Everyone in the family sees, adds and edits every
event (no private events for now). Each event has a version, so two people
editing at once cannot overwrite each other.

**Events.** Title; all-day, timed, or over several days; one or more tags;
location; notes; links to a Contacts entry and to Files. Repeats daily,
weekly on chosen days, monthly (a date, or e.g. "the 2nd Tuesday"), or
yearly; every N; until a date or for a number of times. Changing a repeat
asks: just this one, this and following, or all. Times are in the family's
time zone (TZ); all-day events keep their date.

**Sending events out.** "Add to my calendar" saves one event as an `.ics`
file, which a phone opens in its calendar app and Google Calendar and
Outlook import. A selection (e.g. "Sam's events for the next 3 months",
"Family events this term") goes out as one file. Notes are left out unless
chosen. A sent event does not update outside if it changes later; send it
again.

**Reminders.** Per event: at the time, 15 minutes, 1 hour, 1 day or 1 week
before (any of these), for the people tagged (every parent for Family
events), through the phase 2 notifications. Lock-screen text is generic
("An event starts in 1 hour. Tap to see."). The reminder check runs every
minute. Short reminders need push (ntfy or the browser): the phone's daily
check cannot deliver them in time, and the app says so.

**Birthdays.** Birthdays and anniversaries from Contacts (including family
members kept on a contact, like a friend's young daughter) appear every
year, read from Contacts each time, never copied, with a cake icon. Everyone
in the family sees them (name and day only).

**Outside calendars, with approval.**

- A parent adds a subscription by link (school terms, sport fixtures) with
  a name, default tags and a colour. https only; never addresses on the
  home network; size and time limits; the link is kept encrypted (some
  contain secret tokens); the file is read as data only.
- **Nothing goes straight in.** New events wait in a **Calendar inbox**:
  accept (with the subscription's tags or others), ignore (never shown
  again), or "always accept from this calendar" for trusted sources.
- If an accepted event is moved or cancelled at the source, it returns to
  the inbox as Changed or Cancelled, to accept or keep as it was.
- Clean-up: removing a subscription asks whether to remove its accepted
  events too; inbox items older than 30 days and past subscribed events
  are cleared automatically; each subscription shows when it last updated
  and whether it failed.
- **South African public holidays** are worked out by the hub itself (no
  subscription), on by default and tagged Family.
- One-off `.ics` imports (e.g. from Google Calendar) go through the same
  inbox.

### Build order (one pull request each)

**4a. Events and views**

- [x] People's colours and the Family tag.
- [x] Events: all-day, timed and multi-day; tags; location and notes; links
      to Contacts and Files; versioned edits.
- [x] Repeats, with "this one / this and following / all".
- [x] Month, week and agenda views; my view, a person's view, everyone.
- [x] Today on the home page.
- [x] Send one event, or a selection, out as `.ics`.

**4b. Reminders and birthdays**

- [x] Event reminders, and the reminder check every minute.
- [x] Birthdays and anniversaries from Contacts on the calendar.
- [x] **Family members on a contact** (phase 3 change): "Add a child" on a
      contact keeps the child on that contact (name, birthday, reminder)
      instead of creating a full contact; shown under both parents when
      the contact has a partner; not in the main Contacts list. A full
      contact, if ever needed, is made by hand. Children already added as
      full contacts stay as they are.

**4c. Outside calendars**

- [x] South African public holidays.
- [x] Subscriptions by link, with the Calendar inbox (accept, ignore,
      always accept, changed and cancelled events) and clean-up.
- [x] One-off `.ics` import through the inbox.

## Phase 5 — Health ✅ (some items later)

A health record for each family member, kept by the parents. Agreed with the
owner in the phase 5 planning pull request.

### Design (agreed)

**Who and how.**

- **Parents only**, at least for now; members (including teenagers with an
  account) see nothing. Both parents see and edit everyone's records,
  including each other's. When a parent adds to their own record, the app
  reminds them that the other parent can see it.
- **End-to-end encrypted with the family key**, like Quick Info: the vault
  must be open (fingerprint on the phone, passkey in a browser). One
  encrypted record per item, entry or dose; the server sees only which
  person a record is for and when it changed, never what kind of record it
  is. Search, reports and the emergency card work on the device.
- The people are the same family list as Quick Info and the calendar.
- **Health documents** (results, scripts, X-rays, photos) go in Files, in a
  **Health folder that only parents can open** (enforced by the server), and
  are linked from Health. Files are encrypted at rest with the server key and
  travel over https.

**1. Summary, per person.** Allergies (what to, reaction, severity from mild
to anaphylaxis; severe ones in red at the top; EpiPen flag); conditions
(since, ongoing or resolved, notes); blood type; care notes ("inhaler before
sport"); medical aid shown from Quick Info; doctors and providers linked from
Contacts with a role (GP, paediatrician, dentist, optometrist, specialist,
pharmacy, physio, psychologist, hospital) and a main GP; current medicines.

**2. Medicines.** Name, strength and form; dose and how often; what for;
prescriber and pharmacy; current or past (a course moves to past on its end
date); changes over time. Chronic medicine: script date, repeats left and
script expiry, with reminders.

**3. History.** A dated timeline: visits, diagnoses, procedures, hospital
stays, vaccinations, tests and results, illness or injury, dental and eye
checks; each with provider, notes and linked documents. Filter by type and
year; search.

**4. Vaccinations.** South Africa's childhood schedule (Road-to-Health
booklet) as a checklist per child, by age, with reminders when due; the
built-in schedule can be edited, as it changes. Each dose: given (date,
clinic, batch), missed (catch up later), held back on the doctor's advice
(with the reason), or not applicable. Extra vaccinations (flu, chickenpox,
travel) added freely.

**5. Growth.** Height, weight and head circumference (babies), dated, with a
chart per child, and a reminder to measure (e.g. every 3 months). No WHO
percentile curves for now.

**6. Appointments.** Person, provider, date and time, reason, things to ask.
On the family calendar as "Appointment – Sam" by default, "Dr Naidoo – Sam",
or not at all (the calendar is visible to the whole family). Afterwards,
"How did it go?" becomes a history entry. (To be detailed further later.)

**7. Episodes.** Everything about one illness or injury, from the first
symptom to recovery, to help the parents give everything properly and on
time, and to keep doctors informed.

- Started by a parent ("Sam – fever and cough"): when, first symptoms. Open
  episodes show at the top of Health and on the home page for parents.
- **Timeline** of quick, timestamped entries by either parent: observations
  (temperature, symptoms from a list, pain 0–10, eating, drinking, nappies,
  notes); doses given (medicine, amount, time, by whom); doctor (who, what
  they said, diagnosis, instructions); tests and results; photos and
  documents (Health folder); notes.
- **Medicine plan** as prescribed: dose; how often (every N hours, at set
  times, or as needed with a minimum gap and a maximum per 24 hours); for how
  long. The hub shows the next dose due, late or missed doses, and each dose
  given with time and who. It warns when a dose is logged too soon or would
  pass the daily maximum, **only from what the parents entered from the
  prescription** (it never suggests doses); a warning can be overridden with
  a reason.
- **Dose reminders** to both parents, through the hub's notifications
  ("A medicine is due. Tap to see."): the server knows only that a health
  reminder for that person is due at that time.
- **Hospital stay:** an episode can be upgraded: hospital, ward, admission;
  vitals with times (temperature, heart rate, breathing rate, oxygen
  saturation, blood pressure, weight); ward rounds and conversations with
  doctors (decisions, questions to ask); how they are feeling; photos of
  medicines, X-rays and charts; discharge (date, summary, medicines home).
- **Reports** made on the device: a handover report (summary, timeline,
  doses-given table, temperature and vitals charts, doctors' notes) for the
  whole episode or from a chosen time, and a full record with the list of
  documents.
- **Closing:** an outcome; the episode stays in the history as one folder,
  and a diagnosis or medicine can be added to Conditions or Medicines with
  one tap.
- What one parent logs appears on the other's phone; entries made offline
  (e.g. in hospital) are kept on the phone and sent later (last).

**8. Emergency card** on each parent's phone, offline, opened by fingerprint:
severe allergies, conditions, current medicines, blood type, care notes, ID
number, emergency contacts, medical aid scheme, number and phone. Updated
whenever the vault is open on the phone. No printable card.

**9. Reminders.** Repeat prescriptions, script expiry, follow-ups,
vaccinations due, measuring growth, regular check-ups (dentist, eyes), and
episode doses. The device tells the server only "a health reminder · Sam ·
this date (and time)"; notifications are generic.

**10. PDF summary** for a doctor's visit, made on the device (a small
built-in PDF writer, so it works in the Android app): allergies, current
medicines, ongoing conditions, blood type, doctors; optionally medical aid,
ID number, history for a date range, vaccinations, treatment plans. Preview,
then save or share.

### Build order (one pull request each)

**5a. The record**

- [x] Parents-only Health folder in Files.
- [x] Summary: allergies, conditions, blood type, care notes, medical aid
      from Quick Info, doctors and providers from Contacts.
- [x] Medicines, with changes and chronic scripts.
- [x] History timeline with linked documents; filter and search.
- [x] The "visible to the other parent" reminder on a parent's own record.

**5b. Vaccinations, growth, appointments, reminders**

- [x] The SA childhood schedule per child (editable), with missed, held
      back, not applicable and extra vaccinations.
- [x] Growth measurements, chart, and measuring reminders.
- [x] Appointments, with the calendar choice and "How did it go?".
- [x] Health reminders (repeats, script expiry, follow-ups, vaccinations,
      check-ups) through the notifications.

**5c. Episodes**

- [x] Episodes with the timeline of observations, doses, doctors, tests,
      photos and notes.
- [x] Medicine plans: next dose, late and missed doses, warnings from the
      prescription's limits, dose reminders.
- [x] Hospital stays: vitals, ward rounds, discharge.
- [x] Closing, and adding to Conditions and Medicines.

**5d. Reports and the emergency card**

- [x] The built-in PDF writer; the visit summary; episode handover report
      and full record.
- [x] The offline emergency card on the phone.

**Later**

- [ ] Episode entries made offline, sent when back online.
- [ ] End-to-end encrypted health documents, if ever wanted.
- [ ] Daily reminders for long-term medicines outside an episode.

## Phase 6 — Household admin ✅ (bank presets to come)

Bills, subscriptions and invoices; home and car upkeep; and a monthly budget
with debt payoff. For parents only. Agreed with the owner in the phase 6
planning pull request.

### Design (agreed)

**Principles**

- **Parents only**, like Health. Members do not see the Money or Home pages,
  their reminders or their folder.
- **No account numbers, card numbers or bank logins, ever.** An account is a
  bank name and a nickname ("Capitec, joint"). Amounts are typed in or read
  from a bank's CSV export on the parent's device.
- **Server key (S)** for everything here, chosen by the owner, so the server
  can work out reminders and totals itself (docs/DATA-PROTECTION.md,
  "Household admin").
- Notifications stay generic ("A bill is due. Tap to see.").
- Documents (invoices, receipts, warranties, manuals, service invoices) go in
  a parents-only **Household** folder in Files, like the Health folder.
- No splitting of costs between the parents: a bill can say which account it
  comes from, and that is all.

**1. Bills.** Everything that is paid regularly.

- Payee (from Contacts, or just a name), category, amount, how often
  (monthly, every N months, yearly, once), the due day, and how it is paid
  (debit order, EFT, card, cash), and from which account (nickname).
- Debit orders and card charges count as paid unless a parent marks a
  problem; bills paid by hand are marked paid (date, amount).
- **Price history:** each change of amount is kept with its date ("R199 → R229
  from March"), with the yearly increase shown.
- **Contracts and renewals:** start, end, and the cancellation notice period.
  The reminder comes before the **notice deadline**, not the renewal date,
  so there is still time to cancel or shop around.
- Insurance policies stay in Quick Info; a bill can link to one so the
  premium is not entered twice.
- Overview: fixed costs per month, what is due in the next 7 days, overdue,
  and renewals coming up.

**2. Subscriptions.** A kind of bill with more to it.

- Service, plan, cost and billing cycle (monthly or yearly), next renewal,
  who uses it, and how to cancel (a link or a note).
- **Free trials:** the trial end date, reminded 3 days before and the day
  before, so nothing rolls into a paid plan by accident.
- **"Still using it?"** A review reminder (yearly by default, or chosen) and a
  one-tap "cancelled" that keeps the history.
- Totals: per month and per year (yearly plans spread over 12 months).

**3. Invoices.** Bills that arrive once: the plumber, the school trip, the
vet.

- From whom (Contacts), invoice number, date, due date, amount, status
  (unpaid, paid on a date, disputed, cancelled), notes, and the PDF or photo
  in the Household folder.
- Reminders before the due date and when overdue. A list of unpaid invoices
  with the total; filter by status, payee or year.
- An invoice can belong to a bill (a monthly statement) or to a home or car
  job (a service invoice).

**4. Home and car.**

- **Vehicles** build on the Quick Info vehicle (registration, VIN and licence
  disc stay there, end-to-end encrypted): service history (date, mileage,
  who, cost, what was done, invoice), next service by date or mileage,
  roadworthy, tyres, battery, and warranties.
- **The home:** appliances and other things with a warranty (what, make and
  model, where bought, when, warranty end, receipt and manual in Files).
  Reminded before a warranty ends.
- **Recurring maintenance:** jobs that come back (geyser service, gutters,
  pool, gas bottle, alarm batteries, smoke detectors, aircon filters,
  borehole, pest control) with how often and when last done; reminded when
  due.
- **Tradespeople** come from Contacts. Each job records who did it, the cost,
  and "would use again" (yes, no, or a note), so the next time it is easy to
  choose.

**5. The budget.** A monthly zero-based budget.

- **Every rand gets a job.** Income for the month minus everything planned
  must come to zero: the page shows "left to plan" until it does. Spare
  money goes to a goal (savings, the emergency fund, debt), not left
  unassigned.
- **Made before the month starts.** A reminder near the end of the month to
  plan the next one together; it starts from last month's plan, with bills
  and debt payments filled in.
- **Order of priority:** giving first, then saving, then the essentials
  (food, utilities, housing, transport), then everything else. The essentials
  are marked so they are covered first, especially when income is irregular.
- **Irregular income:** a list in priority order, so whatever comes in is
  allocated down the list.
- **Sinking funds:** categories that save each month for known irregular
  costs (car service, annual insurance, school uniforms, Christmas,
  holidays); their balance carries over from month to month.
- **Planned expenses:** a known cost in a future month ("School camp,
  R1 200, July") shows up in that month's plan, or is saved for a little
  each month from a chosen month (added with the owner, for school costs
  and anything else known ahead).
- **Spending against the plan:** each category shows planned, spent and
  left. Overspending is covered by moving money from another category, so
  the plan always still adds up.
- **Actual spending** comes from the bank's CSV export (see 7), or is typed
  in. Each transaction gets a category; rules learn from the parents'
  choices ("WOOLWORTHS" → Groceries).
- A 12-month view: planned against actual per category, and income against
  spending.

**6. Debt payoff and milestones.**

- **Debts:** credit cards, store cards, car finance, personal loans, student
  loans and money owed to family, with the balance, interest rate and
  minimum payment; the balance is updated by hand or from a statement.
  **The home loan is left out for now** (a separate feature later).
- **Smallest balance first:** debts are listed from the smallest balance to
  the largest. Minimum payments go to all; everything extra goes to the
  smallest. When one is paid off, its whole payment rolls into the next.
  The page shows the order, what to pay each, and a projected debt-free
  date; the budget's debt category follows it.
- **Milestones**, in order, shown as progress:
  1. A starter emergency fund (amount chosen by the parents).
  2. All debt paid off except the home, smallest balance first.
  3. A full emergency fund of 3 to 6 months of essential expenses (worked
     out from the budget).
  4. Saving 15% of household income for retirement.
  5. Saving for the children's education.
  6. Paying off the home early (with the home loan feature, later).
  7. Building wealth and giving.

  The first three are worked out from the budget and the debts; the rest are
  ticked by the parents, with notes.
- No product or person behind these ideas is named in the app.

**7. Bank CSV import.**

- The parent picks the CSV file exported from online banking. It is read
  **on the device**; only the transactions go to the server, never the file.
- Built in: **ABSA** and **Capitec**. A format is recognised by its header
  row; the columns (date, description, amount or money in and out, balance),
  date style and decimal mark are a **saved format**, not code.
- **If a bank changes its export**, or for another bank: the import shows
  the first rows and asks which column is which, then saves that as a new
  format for next time. Built-in formats can be updated the same way without
  waiting for a new version.
- Transactions already imported are recognised and skipped (overlapping
  exports are fine). The import says how many were new, skipped and
  uncategorised.
- Transfers between the family's own accounts can be marked so they are not
  counted as spending.

**Not in this phase:** the home loan (later, its own feature), pets (if ever),
bank connections of any kind.

### Build order (one pull request each)

**6a. Bills, subscriptions and invoices**

- [x] Money page (parents only), accounts (bank and nickname), the
      parents-only Household folder.
- [x] Bills with price history, contracts and notice-period reminders.
- [x] Subscriptions, free trials and review reminders.
- [x] Invoices with status, documents and due reminders.

**6b. Home and car**

- [x] Vehicles (linked to Quick Info), service history and next service.
- [x] Warranties and manuals; recurring maintenance with reminders.
- [x] Jobs, tradespeople and "would use again".

**6c. Budget and debt**

- [x] The zero-based monthly budget, priorities, sinking funds and moving
      money between categories; planned expenses (with saving towards them);
      spending typed in.
- [x] Bank CSV import (saved formats and column mapping), categorising and
      rules.
- [ ] ABSA and Capitec presets, once their export headings are in (owner
      step 21); until then each is set up once with the column mapping.
- [x] Debts, smallest balance first, and the milestones.

**Later**

- [ ] The home loan: balance, extra payments, payoff date (its own
      feature).
- [ ] Pets, if ever: notes kept here. They would live in Health as family
      members of the kind "pet" (vaccinations, medicine plans with dose
      reminders, the vet as a provider, episodes), plus species, breed,
      microchip number, insurance, food, and deworming and tick schedules.

## Phase 7 — School hub ✅

School touches the calendar, the budget, files, contacts and reminders. The
school hub is **a page per child that brings these together without keeping
its own copies**: what is added from it lives in its proper place, tagged
with the child and "school". Agreed with the owner in the phases 7–10
planning pull request. The children are at a private pre-school now; the
design allows for primary and high school later.

- **Per child, per year:** the school, grade or class, and the terms with
  their dates.
- **School contacts,** linked from Contacts with their role (teacher,
  assistant, principal, office, aftercare, coach, lift club), for one child
  or all the children, with a call button and a note.
- **Extra-murals by term** (added with the owner): the activity, who runs it
  (linked to Contacts), where, which days and times, the term or dates,
  the number to call (or contact) to cancel or postpone, the cost and what
  it is per, and where it is paid (a bill, an invoice or a planned
  expense). Each goes on the family calendar weekly for its dates.
- **Reminders** for the irregular things to plan for or take to school (a
  costume, money for a cake sale, book week), for one child or all, with
  how far ahead to remind, ticked when done (added with the owner).
- **School dates as they come:** a quick "new dates from school" form to add
  several at once (open day, sports day, concert, closing day, photo day),
  each a calendar event tagged to the child. Private schools send dates a
  term at a time, so this is the main way in; a school's calendar link can
  be subscribed to (phase 4) where there is one.
- **Fees:** a bill (6a), linked from the child's page.
- **School costs:** planned expenses (6c), tagged "school" and for the
  child: camp, tours, uniform, stationery, photos, the concert costume;
  each saved for over the months before it is needed.
- **Forms and permission slips:** what to sign or pay, with a deadline and a
  reminder; ticked when done.
- **Documents:** reports, letters and forms in Files, in a folder per child
  under a School folder.
- **Lists:** uniform, stationery and kit lists, grade by grade, ticked as
  bought and kept for the next child or next year; "what to bring" for the
  day (swimming bag on Tuesdays, library book on Fridays).
- **Timetable and homework** (for when they are older): the weekly
  timetable, and homework and projects with due dates.
- **"Plan the year":** a checklist at the start of each year or term: add
  the dates, the fees, the planned costs, the stationery list.
- **The children's own view** comes later, with kids' accounts (phase 13);
  the design allows each child to see their own page.

### Build order

- [x] 7a. The child's school page, the School folder, quick dates to the
      calendar, fees and costs linked from Bills & budget; school contacts,
      extra-murals by term and reminders.
- [x] 7b. Forms and permission slips; uniform, stationery and "what to
      bring" lists; "plan the year".
- [x] 7c. Timetable and homework, projects and tests (ready for when
      needed).

## Phase 8 — Wishlists and the gift planner ✅

- **Wishlists** for everyone with an account, kept by themselves: what, a
  link, a rough price, how much they want it, size or colour, notes.
  Parents keep the wishlists of young children without accounts.
- **"I'm getting this":** others mark an item as theirs (or share it, for a
  bigger gift); **the owner never sees who, or that it is taken**, so
  surprises survive.
- **Share links for the children's wishlists**, for grandparents and
  friends without accounts: they see the list and can mark what they are
  getting (with their name), hidden from the child. A link can be turned off.
- **Sizes card** per family member (clothes, shoes, ring), kept up to date,
  for whoever is buying.
- **The gift planner:** one view of the occasions coming up (birthdays and
  anniversaries from Contacts, Christmas, the family's own) with the gift
  ideas for each person (the Contacts gift ideas from phase 3, extended):
  idea → bought → wrapped → given, an amount, and an optional planned
  expense (6c) so December is in the budget. Only the contacts that matter
  get ideas; any contact can start mattering later.

### Build order

- [x] 8a. Wishlists, "I'm getting this" hidden from the owner, sizes.
- [x] 8b. Share links for the children's wishlists.
- [x] 8c. The gift planner across Contacts, with planned expenses.

## Phase 9 — In case of emergency ✅

If something happens to both parents, everything the people taking over the
children need is **taken out of the hub and sent to them as a PDF by
email**, because the hub (on a home server) may not be kept running.

- **Trusted parties, chosen by the parents:** name, email, and role:
  **guardian** (receives the pack; several can be named, since who legally
  takes the children cannot be known in advance) or **to inform** (told the
  pack has gone to the guardians).
- **The letter:** the hub makes a short letter for each trusted party, to
  print and give them now: what this is, the link to use if something has
  happened, and **the password for the pack**. The parents keep the
  password in their password manager. It is never stored on the server.
- **The pack,** made on a parent's device whenever the family vault is open
  (like the emergency card), so it can include everything, end-to-end
  encrypted parts too: the parents' instructions (children's routines and
  care, school, who to call, where the will and policies are, debit orders
  to cancel, the password manager's emergency access, wishes), each child's
  health summary, allergies and medicines, ID numbers, medical aid,
  doctors, emergency contacts, school details, insurance policies, bills
  and accounts (bank and nickname), and the list of documents in Files. It
  is a **password-protected PDF** (AES-256), locked on the device with the
  letter's password; the server stores only the locked file and cannot
  open it. It shows when it was last refreshed, and can be downloaded to
  keep with the will (with a yearly reminder to refresh the printed copy).
- **The instructions** are written in the hub and end-to-end encrypted.
- **Release on request** (settings chosen by the parents; the owner's choice
  shown):
  1. A trusted party opens the link from their letter. Both parents are
     told at once (notification and email) and can cancel.
  2. After the waiting period (**3 days**), a **second confirmation** goes to
     the parents; if neither cancels within its time (24 hours suggested),
     the pack is sent to the guardians, and those to inform are told.
- **Release when nobody is there** (a backstop):
  1. After **7 days** with no activity on the hub from either parent, each
     parent gets a check-in each day ("Are you all right? Tap to confirm.")
     by notification and email.
  2. If **3 days** of check-ins go unanswered, the trusted parties get an
     email asking whether all is well, with a link to request the pack if
     not, and a link to say all is well.
  3. If nobody answers (no parent, and no trusted party saying all is well)
     within a further period (3 days suggested), the pack is sent anyway.
  Any parent's activity, or a trusted party's "all is well", stops it.
- **The email:** plain and universal, with the PDF attached and a pointer to
  the password ("the password is in the letter we gave you"), never the
  password itself.
- **Email from the hub:** the hub learns to send email (no new
  dependencies), through an account the owner gives it (for example Gmail
  with an app password).

### Build order

- [x] 9a. Email from the hub; trusted parties; the letters.
- [x] 9b. The pack: instructions, the password-protected PDF made on the
      device, refreshed when the vault is open; downloading it.
- [x] 9c. Release on request, the second confirmation, the inactivity
      check-ins and the trusted parties' email.

## Phase 10 — Safety: home safe, arrived and SOS (Android) ← planning

Detailed with the owner (planning pull request). Everyone in the family
with an account is told: parents and children alike. The trusted parties
of phase 9 are not part of this.

- **Home safe** on the phone's home page tells the family, with no
  location: "Jo is home safe."
- **Arrived** (in a menu beside it) tells the family and shares the
  location at that moment, with an optional word on where: "Jo arrived
  (gymnastics)". The family sees the coordinates and an **Open in Google
  Maps** link; no map service is built in, so nothing outside the hub and
  Google (only when someone taps the link) learns the location.
- **SOS** beside them: a full red screen that stays up until it is
  cancelled. No call button, no sound, no vibration.
  - The family is alerted at once with the location, then the location is
    sent **every 2 minutes, or every 5 when the battery is low**, in the
    background, even with the screen off, until it is cancelled.
  - **Cancelling asks why:** "Whoops" (sent by mistake), "Emergency
    services have been and gone", "I'm safe now", or a few words, so the
    family knows how worried to be.
  - **Under the SOS, all at once and with no fingerprint** (the owner's
    choice: the quickest way to life-saving information): the emergency
    contact ("Emergency: Dean – 07…"), then blood type, allergies,
    medicines and conditions, from a copy of the phone's emergency card
    kept for this screen only.
  - **From the lock screen too:** a Quick Settings tile ("SOS") starts it
    without unlocking the phone, as does the button in the app. A second
    key on the phone, usable without a fingerprint, lets the server accept
    an SOS (start, locations, end) and nothing else (see
    docs/SECURITY.md).
- **No signal:** each location is kept on the phone and sent when the
  connection is back: **one clean retry, never a burst**. Waiting
  locations go up together in one request, and the family gets one alert
  with the latest, not one per missed point. If there is still no data
  after a minute, the phone **sends an SMS** with the latest coordinates
  and a Google Maps link to the family's phone numbers, then at most one
  SMS every 15 minutes while it stays offline, to each person's number in
  their own Contacts entry. (Needs the SMS permission, asked for when SOS
  is first set up.)
- **In the app, for the family:** the latest check-ins on the home page,
  and a live SOS view (who, since when, each location with its time and
  Google Maps link, and how it ended).
- Locations from check-ins are deleted after 24 hours; an SOS track 24 hours
  after the SOS ends.

### Build order

- [ ] 10a. Home safe and Arrived, the family's notifications and the
      home-page panel.
- [ ] 10b. SOS: the red screen, locations in the background every 2 (or 5)
      minutes, the clean retry, cancelling with a reason, the live view.
- [ ] 10c. With no data: the SMS fallback; the emergency contact and
      medical details on the SOS screen; SOS from the lock screen.

## Phase 11 — Lists, chores and noticeboard

- [ ] **Shopping lists** that update live on every phone, with
      categories (aisle order) and "who's at the shop" mode.
- [ ] **To-dos** with an assignee and a due date; "my tasks" on the home page.
- [ ] **Chore rota:** recurring chores that rotate between people, tick-off
      with a streak, optional points that turn into pocket money.
- [ ] **Noticeboard:** short announcements and pinned notes for everyone
      ("Plumber coming Thursday 10:00"), with read receipts.
- [ ] **Notifications** for lists, chores and the noticeboard, through the
      push system built in phase 2.

A first draft was discussed on 23 November 2026, before Health and Household
admin were moved ahead: several shopping lists that update live (Server-Sent
Events, polling as a fallback), sorted by a built-in South African category
list; "I'm at the shop"; to-dos with people, due dates and repeats, shown on
the calendar; a rotating chore rota with streaks and optional pocket money;
a noticeboard with pinned and expiring posts and read receipts. Open
questions to settle when this phase starts: server key or plain storage
(server key suggested); whether "I'm at the shop" may name who; whether a
child's chore tick counts at once or needs a parent; points or rand for
chores; who may set up chores and mark pocket money paid; an offline copy of
shopping lists on the phone; replies or reactions on posts; anything missing
(e.g. lend and borrow).

## Phase 12 — Meals

- [ ] Weekly meal planner (drag recipes onto days).
- [ ] Recipe box: ingredients, steps, photos, tags; import from a recipe
      website link (optional, as it fetches from outside).
- [ ] "Add this week's ingredients to the shopping list", merging duplicates.
- [ ] Dietary notes per person (allergies from Health when available).

## Phase 13 — Family life extras (pick and choose)

- [ ] **Kids' accounts:** a `child` role that sees chosen modules only (lists,
      chores, calendar), with a simpler home page. Keep Quick Info and Health
      parent-managed until family member access is designed.
- [ ] **Extended family:** a `guest` role for grandparents or a babysitter
      with access to chosen items only (the emergency card, the calendar).
- [ ] **Trips:** itinerary, bookings and documents (from Files and Quick
      info), packing lists per person, shared expenses.
- [ ] **Memories:** explore showing an "on this day" view from Immich on the
      home page. Immich remains the family photo library.

## Cross-cutting work (slot in where it fits)

- [ ] **Passkeys (WebAuthn)** as a second factor alongside TOTP, and for a
      faster browser sign-in.
- [ ] **Account recovery:** an admin-issued one-time link to set a new
      password (the person still needs their second factor).
- [ ] **Search** across all modules.
- [ ] **Offline on the phone:** read-only cache of lists, calendar and the
      emergency card.
- [ ] **Android home-screen widgets:** today's calendar, the shopping list.
- [ ] **Built-in scheduled backups** of `/data` to a second disk or an
      rclone remote, with restore instructions tested in CI.
- [ ] **Data export** of everything a person owns, as plain files.
- [ ] **Accessibility pass** (keyboard, screen readers, large text) and
      **translations** if the family wants them.
- [ ] **Family key rotation:** make a new family key and re-encrypt the vault
      (for example after removing a parent or losing a device), and a new
      recovery key.
- [ ] **Security hardening backlog:** session list showing approximate location, e-mail or
      push alert on a new sign-in, admin view of the family's security activity.

## What has been verified, and how

Automated on every relevant change (`.github/workflows/build.yml`):

- `npm test`: server unit and integration tests over real HTTP (setup, sign-in
  stages, TOTP vectors and replay, recovery codes, lockout, invites, roles,
  device keys and challenges, session lifetimes, CSRF and CORS rules, static
  serving and path traversal), document uploads/downloads, shared access,
  folder operations, preview type checks, recycle-bin restoration and expiry,
  backup restoration, and the Android updater's release parsing.
- `npm run e2e`: the web app in Chromium against a real server: setup,
  two-factor set-up with recovery codes, inviting a member who joins and sets
  up their own two-factor, member restrictions, sign out, wrong password,
  sign-in with a fresh code, phone-sized layout; document upload/download,
  PDF and image previews, folders, search, rename, move, delete and restore.
- `npm run e2e:mobile`: the Android app's web layer in a phone-sized browser:
  connect (http refused), password and code, device registration, unlock by
  signed challenge, lock, reload, signing the phone out. The keystore is a
  WebCrypto stand-in here.
- The Docker image is built, started on a root-owned bind mount as PUID 99,
  health-checked and scanned. A stopped-volume archive is restored into a
  fresh container with a changed PUID; accounts, folders, document bytes,
  recycle-bin recovery and SQLite integrity are checked.
- The debug APK is built and its version checked; its libraries are scanned.

Not yet verified on a real phone (to do after the first release with a
signing key): the native biometric prompt and keystore key on a physical
device, `FLAG_SECURE`, updating from one release to the next, and native
document save/open through Android's picker and installed viewer apps.
