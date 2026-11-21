# Family Hub — roadmap

The plan for building Family Hub in phases, and the hand-over document for
work in a fresh session: what exists, what is next, and what was decided.
**Tick items off here in the pull request that lands them.**

Each phase is one or more pull requests into `main`, and usually ends in a
release (`release: minor`). The order after phase 1 is a proposal: reorder
freely. Routine upkeep has its own procedure in [MAINTENANCE.md](MAINTENANCE.md);
the security model is in [SECURITY.md](SECURITY.md).

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

## Phase 2 — Quick info (the family's reference card) ← next

ID and passport numbers, medical aid, policy numbers, Wi-Fi passwords:
always to hand, never in plain text.

- [ ] **Encryption at rest** for this module (and the TOTP secrets), with a
      key kept outside the database (a key file or Docker secret), so a copy
      of the database alone reveals nothing. Ask-first item: agree the design
      (server-side envelope encryption vs. end-to-end family key) before building.
- [ ] Items per person or for the family, from templates: ID document,
      passport, driver's licence, medical aid / health insurance, blood type
      and allergies, doctor and dentist, insurance policies, vehicle
      registration and licence renewal, bank branch codes (no passwords or
      PINs), school details, Wi-Fi and alarm codes, emergency contacts.
- [ ] Sensitive fields hidden until revealed; revealing needs a fresh code
      (web) or fingerprint (phone); copy clears the clipboard after 30 s; every
      reveal goes in the audit log.
- [ ] **Expiry reminders:** passports, licences, vehicle licence discs,
      policies: "renew in 60 days".
- [ ] Attach a scan from Files (front and back of an ID card).
- [ ] **Emergency card:** the medical basics and emergency contacts for each
      person, readable on the phone even offline (encrypted on the device,
      opened with a fingerprint).

## Phase 3 — Family calendar

- [ ] Events with a colour per person, all-day and timed, recurring, with
      locations and notes; month, week and agenda views.
- [ ] Reminders (needs the notification work below).
- [ ] Birthdays and anniversaries from member profiles, shown every year.
- [ ] Subscribe to outside calendars (school terms, sports fixtures, public
      holidays) by iCal URL, read-only.
- [ ] A private iCal feed per person so the family calendar shows in Google
      Calendar, Outlook or the phone's own calendar.
- [ ] "Who's where" today on the home page.

## Phase 4 — Lists, chores and noticeboard

- [ ] **Shopping lists** that update live on every phone, with
      categories (aisle order) and "who's at the shop" mode.
- [ ] **To-dos** with an assignee and a due date; "my tasks" on the home page.
- [ ] **Chore rota:** recurring chores that rotate between people, tick-off
      with a streak, optional points that turn into pocket money.
- [ ] **Noticeboard:** short announcements and pinned notes for everyone
      ("Plumber coming Thursday 10:00"), with read receipts.
- [ ] **Notifications (cross-cutting, needed from here on):** web push in the
      browser and Android notifications through a self-hostable route
      (UnifiedPush / ntfy) so nothing depends on Google's servers; per-person
      settings for what notifies.

## Phase 5 — Meals

- [ ] Weekly meal planner (drag recipes onto days).
- [ ] Recipe box: ingredients, steps, photos, tags; import from a recipe
      website link (optional, as it fetches from outside).
- [ ] "Add this week's ingredients to the shopping list", merging duplicates.
- [ ] Dietary notes per person (allergies from Quick info).

## Phase 6 — Household admin

- [ ] **Bills and renewals:** due dates, amounts and reminders for
      subscriptions, insurance, rates, school fees; who pays what. No bank
      connections: amounts are typed in.
- [ ] **Simple budget:** monthly categories, planned vs. actual, entered by hand
      or imported from a bank CSV export.
- [ ] **Home & car:** service history, warranties and manuals (linked to
      Files), next service due, licence and roadworthy dates, trusted
      contacts (plumber, electrician, mechanic).
- [ ] **Pets:** vet, vaccinations, medication schedule.

## Phase 7 — Family life extras (pick and choose)

- [ ] **Kids' accounts:** a `child` role that sees chosen modules only (lists,
      chores, calendar), with a simpler home page and no access to Quick info.
- [ ] **Extended family:** a `guest` role for grandparents or a babysitter
      with access to chosen items only (the emergency card, the calendar).
- [ ] **Trips:** itinerary, bookings and documents (from Files and Quick
      info), packing lists per person, shared expenses.
- [ ] **Health records:** vaccinations, prescriptions and repeat-medication
      reminders, appointment history per person.
- [ ] **School hub:** term dates, timetables, homework, uniform and kit lists,
      teacher contacts.
- [ ] **Gift ideas and wishlists:** ideas hidden from the person they are
      for; birthday reminders link to them.
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
- [ ] **Security hardening backlog:** encrypt the TOTP secrets at rest (with
      phase 2's key), session list showing approximate location, e-mail or
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
