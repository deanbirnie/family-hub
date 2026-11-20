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
session. Sign-in refuses to set a cookie over plain http (other than to
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

- State-changing requests must carry `X-Requested-With: family-hub`, which a
  cross-site form cannot send; requests marked `Sec-Fetch-Site: cross-site`
  are refused unless they come from the app's own origin (CORS allows only
  `https://localhost`, Capacitor's, and never with credentials).
- Every response: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, a tight
  `Permissions-Policy`, and HSTS over https. The page has a strict CSP
  (`script-src 'self'`, nothing from other origins, no framing).
- API responses are `Cache-Control: no-store`.
- JSON bodies are limited to 64 KiB; slow clients are cut off.

## The server and its data

- The container starts as root only to take ownership of `/data`, then runs
  as `PUID:PGID`. The image has no npm, npx, yarn or corepack.
- `/data/family-hub.db` (SQLite) holds account data, password hashes, TOTP
  secrets and the audit log. **Protect and back up this volume.** TOTP
  secrets are not encrypted at rest (anyone with the database could generate
  codes, but would still need passwords); encrypting sensitive data at rest is
  on the roadmap with the Quick info module.
- The audit log records sign-ins, failures, lockouts and account changes with
  the client address; each person sees their own in Settings.

## Reporting a problem

Open a private security advisory on the GitHub repository rather than an issue.
