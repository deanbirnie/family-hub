# Family Hub

A private, self-hosted hub for coordinating family life: shared files,
quick-reference information, a family calendar and more, built in phases
(see [the roadmap](docs/ROADMAP.md)). It runs on your own server with Docker,
in any browser, and as an Android app.

Security comes first. Everyone signs in with a password **and** a code from an
authenticator app; on Android, the app opens only with a fingerprint or face,
enforced by the server through a key in the phone's hardware keystore. See
[docs/SECURITY.md](docs/SECURITY.md).

| Part | Where | What |
|---|---|---|
| Server | `apps/server` | Node 24, no npm dependencies (`node:http`, `node:sqlite`, built-in Argon2id). The API, sign-in, and serving the web app. |
| Shared interface | `packages/ui` | React screens used by both the web and Android apps. |
| Web app | `apps/web` | The interface in the browser, served by the server. |
| Android app | `apps/mobile` | The interface in a Capacitor shell, with biometric unlock and in-app updates. Android 11 or newer. |

## Running it at home

**Setting it up yourself?** Follow [docs/OWNER-STEPS.md](docs/OWNER-STEPS.md):
every step only you can do, in order, with exact commands.

You need Docker, and an **https** address for the server: sign-in refuses
plain http, and the Android app only talks to https. A reverse proxy you
already run (Caddy, Traefik, nginx, Nginx Proxy Manager, or a Cloudflare
tunnel) is all it takes.

1. Copy [`docker-compose.yml`](docker-compose.yml) to the server and start it:

   ```bash
   docker compose up -d
   ```

   It listens on `127.0.0.1:8080`, with its database in the `family-hub-data`
   volume.
2. Point your reverse proxy's https address at `http://127.0.0.1:8080`. The
   compose file sets `FAMILY_HUB_TRUST_PROXY=1`, so the server trusts that one
   proxy's `X-Forwarded-For` and `X-Forwarded-Proto`; set it to the number of
   proxies in front, or `0` if there are none.
3. Open the https address in a browser. The first visit sets up the family
   and your admin account, then two-factor sign-in.
4. Invite the family from **Family → Invite someone**, and send each person
   their link.

To update: `docker compose pull && docker compose up -d`. Images are
`ghcr.io/deanbirnie/family-hub` with tags `latest`, `X.Y` (patch updates
only), `X.Y.Z`, and `edge` (the newest commit on `main`; for testing).

**Back up the whole data volume.** Stop the hub during the copy so its
database and documents stay consistent. See [backup and restore](docs/BACKUPS.md)
for commands and verification.

### Settings

| Variable | Default | |
|---|---|---|
| `PUID`, `PGID` | `1000` | User and group the server runs as and that own `/data` (Unraid: `99`, `100`). |
| `FAMILY_HUB_TRUST_PROXY` | `0` | Number of reverse proxies in front whose forwarded headers are trusted. |
| `FAMILY_HUB_ALLOW_HTTP` | `false` | Allow browser sign-in over plain http. Only for a quick test on a home network. |
| `FAMILY_HUB_APP_ORIGINS` | `https://localhost` | Origins allowed to call the API with a bearer token (the Android app's). |
| `PORT` | `8080` | |
| `FAMILY_HUB_KEY_FILE` | `/keys/server.key` | The server key that encrypts documents and sign-in secrets at rest. Keep it on its own mount (not inside `/data`) and copy it to a password manager: see [backups](docs/BACKUPS.md). |
| `FAMILY_HUB_MAX_FILE_BYTES` | `104857600` (100 MiB) | Maximum size of one document upload; up to 2 GiB. Set a matching or larger request limit on your reverse proxy. |
| `TZ` | `UTC` (the compose file sets `Africa/Johannesburg`) | The family's time zone: which day reminders are due, and from what time of day they are sent. |
| `FAMILY_HUB_PUBLIC_URL` | (learnt) | The hub's https address, e.g. `https://hub.example.com`. Push services are told it as the sender of notifications. If unset, the address a browser uses when turning notifications on is remembered. |
| `FAMILY_HUB_SMTP_HOST` | (none: no email) | The mail server the hub sends through, e.g. `smtp.gmail.com`. Used in an emergency (and for a test from Settings → In case of emergency). |
| `FAMILY_HUB_SMTP_PORT` | `465` | `465` for TLS from the start, `587` for STARTTLS. Mail always travels encrypted. |
| `FAMILY_HUB_SMTP_USER`, `FAMILY_HUB_SMTP_PASSWORD` | | The account to sign in as, and its password (for Gmail, an app password). `FAMILY_HUB_SMTP_PASSWORD_FILE` reads the password from a file instead (a Docker secret). |
| `FAMILY_HUB_SMTP_FROM`, `FAMILY_HUB_SMTP_FROM_NAME` | the user; `Family Hub` | The address mail comes from, and the name shown with it. |

### Shared documents

Open **Files** to upload and download documents from the shared Family folder.
Every signed-in family member has access. File requests use the current
session: opening or downloading a document never asks for another code or
fingerprint. The Android app's normal lock rules still apply.

Uploads are streamed to `/data/files`; names and folders are stored in the
hub database. Choose several documents at once or drop them onto the Files
page. Documents with the same name in the same folder are refused rather
than overwritten.

Create subfolders, rename or move documents, and search across the Family
folder by filename. PDFs, PNG, JPEG, GIF and WebP images preview inside the
app on both platforms. Other formats download; Android also offers **Open**
with a chosen installed app. PDF rendering and its fonts ship with Family
Hub; documents are never sent to an outside viewer service.

All members can rename, move, delete and restore shared documents. Deleted
documents and folders stay in the **Recycle bin** for 30 days. A restored
folder brings back the items deleted with it; earlier independent deletions
stay in the bin. If the original parent is unavailable, restoration uses
Family. Name conflicts receive a ` (restored)` suffix without replacing
anything. Expired items are purged at startup and during regular cleanup.

## The Android app

Download `family-hub-X.Y.Z.apk` from the [latest release](https://github.com/deanbirnie/family-hub/releases/latest)
on the phone and open it (Android asks once to allow installing from the
browser). Enter the server's https address, sign in with password and code,
and turn on fingerprint unlock. The phone then appears under **Settings →
Your phones**, where it can be removed if lost.

The app checks GitHub for a new release when it starts or comes back to the
foreground (at most every 6 hours), shows a banner when there is one, and
downloads and installs it from **Settings → App updates**.

### Android signing key

Android only installs an update over an existing app when both are signed
with the same key, so releases need one fixed signing key, kept in repository
secrets, never in the repository. **Until it is set up, releases are
published without an APK.** Set it up once:

1. Create a keystore (any machine with Docker; choose your own password in
   both places):

   ```bash
   docker run --rm -v "$PWD":/out eclipse-temurin:21-jdk keytool -genkeypair -keystore /out/family-hub-release.jks -alias family-hub -keyalg RSA -keysize 4096 -validity 10000 -storepass 'CHOOSE-A-PASSWORD' -keypass 'CHOOSE-A-PASSWORD' -dname "CN=Family Hub"
   ```

2. Print it as one line of text:

   ```bash
   base64 -w0 family-hub-release.jks
   ```

3. Print its certificate fingerprint:

   ```bash
   docker run --rm -v "$PWD":/out eclipse-temurin:21-jdk keytool -list -v -keystore /out/family-hub-release.jks -alias family-hub -storepass 'CHOOSE-A-PASSWORD'
   ```

   and copy the `SHA256:` value.
4. In the repository on GitHub, open **Settings → Secrets and variables →
   Actions**. Under **Secrets**, add:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | the output of step 2 |
   | `ANDROID_KEYSTORE_PASSWORD` | the password you chose |
   | `ANDROID_KEY_ALIAS` | `family-hub` |
   | `ANDROID_KEY_PASSWORD` | the same password |

   Under **Variables**, add `ANDROID_RELEASE_CERT_SHA256` with the
   fingerprint from step 3. Each release checks the APK is signed by it.
5. Keep `family-hub-release.jks` and its password somewhere safe (a password
   manager). **If they are lost, no future version can install over the ones
   already on your phones**: everyone would have to uninstall and reinstall.

Pull requests also build a debug APK (the `family-hub-android-debug`
artifact). It is signed with a throwaway key and has its own app ID
(`dev.familyhub.app.debug`), so it installs next to the release app.

## Releasing

One version number covers the app, the GitHub release and the image. It comes
from the release itself, not from `package.json` (whose `0.1.0` is only what
source builds report).

Merge pull requests as they are ready; they release nothing on their own.
When one should ship everything merged so far, give it a label, before or
after merging:

| Label | Version change | For |
|---|---|---|
| `release: patch` | 0.3.0 → 0.3.1 | fixes |
| `release: minor` | 0.3.0 → 0.4.0 | new features |
| `release: major` | 0.3.0 → 1.0.0 | breaking changes |

`.github/workflows/release-on-merge.yml` counts on from the latest release and
starts `.github/workflows/release.yml` on the merge commit. That runs every
test, builds and checks the signed APK, scans the APK's libraries and the
image for known vulnerabilities, pushes the image, and creates the GitHub
release with the APK attached. To choose the version yourself, use **Actions
→ Release → Run workflow**, or push a tag such as `v0.2.0`.

## Maintenance

A scheduled Claude task runs [docs/MAINTENANCE.md](docs/MAINTENANCE.md) every
week and opens a pull request when something needs updating. Dependabot also
proposes dependency updates weekly, and `.github/workflows/cleanup.yml` keeps
old artifacts, releases and images from piling up.

## Development

Node 24.7 or newer.

```bash
npm install
```

```bash
npm run dev:server
```

```bash
npm run dev
```

The first runs the API on port 8080 (data in `./data`, plain http allowed);
the second serves the web app with live reload on Vite's port and forwards
`/api` to it. Checks:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run e2e
```

```bash
npm run e2e:mobile
```

The end-to-end tests need Chromium (`CHROME_PATH`, or Playwright's own). An
APK needs the Android SDK and JDK 21: `npm run apk -w @family-hub/mobile`.
