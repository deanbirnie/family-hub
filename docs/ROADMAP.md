# Family Hub — roadmap

The plan for building Family Hub in phases, and the hand-over document for
work in a fresh session: what exists, what is next, and what was decided.
**Tick items off here in the pull request that lands them.**

Each phase is one or more pull requests into `main`, and usually ends in a
release (`release: minor`). The order after phase 1 is a proposal: reorder
freely. Routine upkeep has its own procedure in [MAINTENANCE.md](MAINTENANCE.md);
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

## Phase 2 — Quick Info, Family Contacts and notifications ← next

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
| **Family key** (end-to-end) | Quick Info, and Health in phase 8 | Only parents' unlocked devices. The server stores ciphertext and never sees the key. |
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

## Phase 3 — People and dates (a family CRM)

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

## Phase 4 — Family calendar

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

- [ ] Event reminders, and the reminder check every minute.
- [ ] Birthdays and anniversaries from Contacts on the calendar.
- [ ] **Family members on a contact** (phase 3 change): "Add a child" on a
      contact keeps the child on that contact (name, birthday, reminder)
      instead of creating a full contact; shown under both parents when
      the contact has a partner; not in the main Contacts list. A full
      contact, if ever needed, is made by hand. Children already added as
      full contacts stay as they are.

**4c. Outside calendars**

- [ ] South African public holidays.
- [ ] Subscriptions by link, with the Calendar inbox (accept, ignore,
      always accept, changed and cancelled events) and clean-up.
- [ ] One-off `.ics` import through the inbox.

## Phase 5 — Lists, chores and noticeboard

- [ ] **Shopping lists** that update live on every phone, with
      categories (aisle order) and "who's at the shop" mode.
- [ ] **To-dos** with an assignee and a due date; "my tasks" on the home page.
- [ ] **Chore rota:** recurring chores that rotate between people, tick-off
      with a streak, optional points that turn into pocket money.
- [ ] **Noticeboard:** short announcements and pinned notes for everyone
      ("Plumber coming Thursday 10:00"), with read receipts.
- [ ] **Notifications** for lists, chores and the noticeboard, through the
      push system built in phase 2.

## Phase 6 — Meals

- [ ] Weekly meal planner (drag recipes onto days).
- [ ] Recipe box: ingredients, steps, photos, tags; import from a recipe
      website link (optional, as it fetches from outside).
- [ ] "Add this week's ingredients to the shopping list", merging duplicates.
- [ ] Dietary notes per person (allergies from Health when available).

## Phase 7 — Household admin

- [ ] **Bills and renewals:** due dates, amounts and reminders for
      subscriptions, insurance, rates, school fees; who pays what. No bank
      connections: amounts are typed in.
- [ ] **Simple budget:** monthly categories, planned vs. actual, entered by hand
      or imported from a bank CSV export.
- [ ] **Home & car:** service history, warranties and manuals (linked to
      Files), next service due, licence and roadworthy dates, links to
      trusted tradespeople in Family Contacts.
- [ ] **Pets:** vet, vaccinations, medication schedule.

## Phase 8 — Health

A parent-managed health profile for each family member. Apply the parent
access rules from Phase 2, enforce them on the server, and encrypt health
records end to end with the family key from phase 2. Show medical aid details from Quick Info through a link.

- [ ] **At a glance:** allergies and known reactions, blood type if known,
      active conditions and essential care notes.
- [ ] **Healthcare providers:** link Family Contacts for the person's GP,
      paediatrician, dentist, specialists and pharmacy, with a role for each.
- [ ] **Medication list:** current and past medications, with dose, schedule,
      start and end dates, and prescribing provider where known.
- [ ] **Medical history:** dated diagnoses, procedures, hospital stays,
      vaccinations and significant appointments.
- [ ] **PDF export:** preview and export a short appointment summary or
      selected history by date range. The default summary includes allergies,
      current medications, relevant conditions and provider details. Parents
      can explicitly add medical aid information, ID numbers or older history.
- [ ] **Treatment plans:** family-recorded care instructions, the provider
      who gave them, follow-up dates and links to suitable documents.
- [ ] **Repeat-prescription reminders:** reminders for upcoming renewals.
- [ ] **Offline emergency card:** selected allergies, essential medications
      and emergency contacts. Encrypt the card on the phone and require
      biometric verification to open it.

## Phase 9 — Family life extras (pick and choose)

- [ ] **Kids' accounts:** a `child` role that sees chosen modules only (lists,
      chores, calendar), with a simpler home page. Keep Quick Info and Health
      parent-managed until family member access is designed.
- [ ] **Extended family:** a `guest` role for grandparents or a babysitter
      with access to chosen items only (the emergency card, the calendar).
- [ ] **Trips:** itinerary, bookings and documents (from Files and Quick
      info), packing lists per person, shared expenses.
- [ ] **School hub:** term dates, timetables, homework, uniform and kit lists,
      teacher contacts.
- [ ] **Wishlists:** family members with accounts keep their own wishlist;
      ideas others add for them stay hidden from them. (Gift ideas for
      friends and family are in phase 3.)
- [ ] **"I'm home safe" check-ins:** one tap to tell the family you arrived
      (no location tracking).
- [ ] **Memories:** explore showing an "on this day" view from Immich on the
      home page. Immich remains the family photo library.
- [ ] **In case of emergency:** instructions and where things are kept, for a
      trusted person, released after a waiting period an admin can cancel.

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
