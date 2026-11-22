# Security model

Family Hub will hold the family's documents and identity numbers, so signing
in is deliberately strict. This file explains what protects what, so changes
can be judged against it.

## Accounts

- **No open sign-up.** The first account is created at first-run setup and
  becomes an admin. Everyone else joins through a one-time invite link an
  admin creates (valid 7 days; only its SHA-256 is stored).
- **Passwords** are hashed with Argon2id (64 MiB, 3 passes, 4 lanes; RFC 9106's
  second recommended setting) using Node's built-in `crypto.argon2`. Stored
  hashes with older settings are re-hashed at the next sign-in. A password
  needs at least 12 characters and must not contain the username; there are
  no composition rules (NIST SP 800-63B).
- **Admins** can change roles, turn accounts off (signs them out everywhere)
  and reset a member's two-factor sign-in after a lost phone. The family
  always keeps at least one admin.

## Browser: password + authenticator code, always

1. Password → a short session (`stage: totp`, 10 minutes) that can only
   submit a code. An account without an authenticator gets `stage: enroll`
   instead and must set one up before anything else.
2. A 6-digit TOTP code (RFC 6238, SHA-1, 30 s, ±1 step) → the full session.
   Each code is accepted once (the last used time step is stored and checked
   atomically). Recovery codes (10, single use, stored hashed) replace a code
   when the phone is lost.
3. Every step issues a **new** session token and deletes the old one.

The session is an `HttpOnly`, `Secure`, `SameSite=Strict` cookie named
`__Host-fh_session`, lasting 14 days at most and ending after 2 days unused.
Only its SHA-256 is stored. Changing the password signs out every other
session and removes every other registered phone (the phone making the
change, if any, stays). Sign-in refuses to set a cookie over plain http (other than to
`localhost`) unless `FAMILY_HUB_ALLOW_HTTP=true`.

## Android: password + code once, then fingerprint or face, every time

1. On a new phone: password and code as above, with `client: "app"`. The
   result is a `stage: device` bearer token that can do one thing: register
   this phone's key.
2. The app makes an **ECDSA P-256 key in the Android Keystore** (StrongBox
   where available): non-exportable, usable only straight after a strong
   (class 3) biometric check, once per check, and destroyed if a new
   fingerprint or face is enrolled. The server stores the public key.
3. To open the app: the server sends a one-time challenge (2 minutes, used
   once), the person touches the sensor, the keystore signs
   `family-hub-device-unlock\n<challenge>\n<deviceId>`, and the server checks
   the signature before issuing a bearer session (12 hours at most, 2 hours
   unused). The token is kept only in memory; the app locks after 2 minutes
   in the background.

So the server itself enforces "this registered phone, and a biometric check
just now"; a copied token file or a stolen password is not enough. There is
deliberately no PIN or device-credential fallback. Removing a phone in
Settings (or an admin's two-factor reset) ends its sessions and stops it
unlocking. The app's window is `FLAG_SECURE` (no screenshots, blank in the
recent-apps list), backups are off, and plain-http traffic is refused.

## Slowing down guessing

- 30 sign-in requests per 15 minutes per address (password, code, device
  unlock); 60 for invite look-ups.
- 5 failed passwords or codes within 15 minutes lock the account for 15
  minutes, doubling with each further lock up to a day. Unknown usernames take
  as long to answer as real ones and get the same message.
- 5 wrong codes end that sign-in attempt.

## Requests

- API requests whose `Sec-Fetch-Site` is anything but `same-origin` or
  `none` are refused unless they come from the app's own origin. That
  includes other services on sibling subdomains of the same home server.
- State-changing requests must carry `X-Requested-With: family-hub`, which a
  cross-site form cannot send. CORS allows only the app's origin
  (`https://localhost`, Capacitor's), and never with credentials.
- Every response: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, a tight
  `Permissions-Policy`, and HSTS over https. The page has a strict CSP
  (`script-src 'self'`, nothing from other origins, no framing).
- API responses are `Cache-Control: no-store`.
- JSON bodies are limited to 64 KiB; headers must arrive within 20 s, and a
  connection idle for 2 minutes is closed. A whole request has no time
  limit, so large uploads over slow links still finish.

## The server and its data

- Shared documents require an existing full session on every request. All
  members have equal access to the shared Family folder. There is no extra
  authentication step for file operations, and no public file links or
  bearer tokens in URLs. Uploads are streamed with a per-file limit; disk
  names are server-generated IDs. Downloads are attachments with a sandbox
  policy and no caching. Preview eligibility is checked against the file's
  byte signature, not the supplied MIME type or filename. Only PDFs and
  raster images are previewed, using a local PDF renderer or an image element;
  HTML and SVG remain downloads. PDF scripts and forms are not executed.

- The container starts as root only to take ownership of `/data`, then runs
  as `PUID:PGID`. The image has no npm, npx, yarn or corepack.
- `/data/family-hub.db` (SQLite) holds account data, password hashes, TOTP
  secrets and the audit log. **Protect and back up this volume.**
- **Server key at rest:** TOTP secrets and document contents are encrypted
  with a key file kept outside `/data` (`/keys/server.key`), so a copy of the
  database, the documents or a backup alone reveals neither. Each value is
  bound to its owner (a secret to its user, a document's chunks to that
  document, in order, with the end marked), so it cannot be moved, swapped or
  cut short unnoticed. The server refuses to start if encrypted data exists
  and the key is missing or wrong, rather than making a new key. Details:
  [DATA-PROTECTION.md](DATA-PROTECTION.md) and [BACKUPS.md](BACKUPS.md).
- The audit log records sign-ins, failures, lockouts and account changes with
  the client address; each person sees their own in Settings. Entries older
  than a year are removed.

## What a stolen database or backup reveals

See [DATA-PROTECTION.md](DATA-PROTECTION.md): every piece of stored data and
whether it is end-to-end encrypted, encrypted with the server key, hashed or
plain.

## Planned in phase 2 (not built yet)

Agreed design; details in docs/ROADMAP.md, "Phase 2 → Design (agreed)".

- **Family key, end to end:** Quick Info (and later Health) is encrypted on
  parents' devices with a family key the server never sees. Parents only;
  members cannot read it. A recovery key, kept in a password manager, is the
  only way back if every parent device is lost.
- **Unlocking it never takes a password alone:** a biometric check on
  Android (the one that opens the app), and a passkey or approval from the
  parent's phone in a browser. Unlocked once per session; the browser vault
  locks after 15 minutes unused.
- **Server key at rest** (TOTP secrets and documents already, above): Family
  Contacts and push addresses join them.
- **Notifications** (UnifiedPush and Web Push, RFC 8291 encrypted) carry
  generic text only. Reminder records (what, whose, when) are readable by the
  server so it can send them; the underlying numbers are not.

## Reporting a problem

Open a private security advisory on the GitHub repository rather than an issue.
