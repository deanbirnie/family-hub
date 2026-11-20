# Maintenance policy

How to keep Family Hub's dependencies, toolchain and code patterns current and
safe. It is written to be handed to an AI coding agent (or followed by a
person) every week. A scheduled Claude task does exactly that, every Monday:

> Read `docs/MAINTENANCE.md` and carry out a maintenance run.

A run ends with either a pull request or a short note that nothing needed
changing, plus a new row in the [run log](#run-log) at the bottom of this file.

## Goals, in priority order

1. **No known vulnerabilities** in anything that ships: the Docker image (the
   server, the web app and the OS packages under them), the Android app, and
   the libraries bundled into them.
2. **Nothing deprecated or broken** in use: no deprecated APIs, no end-of-life
   runtimes, no abandoned packages.
3. **Stay close to current** releases so that upgrades remain small.
4. **Never trade away safety or behaviour for freshness.** An upgrade that
   weakens the security model (docs/SECURITY.md) or cannot be verified is not made.

## What there is to maintain

| Area | Where | Notes |
|---|---|---|
| npm packages | the root `package.json` and one in each folder under `packages/` and `apps/`, one root `package-lock.json` | npm workspaces. The server has **no** dependencies on purpose. Shipped code: `react`, `react-dom`, `lucide-react`, `uqr`, `@capacitor/*` (bundled into the web and Android apps). |
| Node.js | `engines` in `package.json`, `.nvmrc`, `node-version` in `.github/workflows/*.yml`, `FROM node:…` in `Dockerfile` | The server relies on Node 24 built-ins: type stripping, `node:sqlite`, `crypto.argon2`. Keep all four places on the same major. |
| GitHub Actions | `uses:` lines in `.github/workflows/*.yml` | Pinned by full commit SHA with the version in a comment. Review permissions, especially for actions that publish, sign or delete. |
| Android toolchain | `apps/mobile/android` (`variables.gradle`, `build.gradle`, `app/build.gradle`, `gradle/wrapper/gradle-wrapper.properties`), `java-version` in the workflows | Capacitor sets the expected Gradle, Android Gradle Plugin, JDK and SDK levels. Upgrade Capacitor majors with its migration guide (`npx cap migrate`), and raise `targetSdkVersion` when Google's requirement moves. |
| Android libraries | `androidx.biometric` in `apps/mobile/android/app/build.gradle` | Security-critical: the biometric prompt that unlocks the device key. Not covered by `npm audit`; CI scans the release classpath with OSV-Scanner. |
| Docker base image | `Dockerfile` | Built on every relevant PR and release; scanned, OS packages included. |
| Cryptography | `apps/server/src/secrets.ts`, `apps/server/src/totp.ts`, `apps/server/src/routes/devices.ts`, `apps/mobile/android/.../DeviceAuthPlugin.java` | Argon2id parameters, TOTP, device keys. See "Cryptography review". |

## Procedure

Work on a fresh branch from `main`. Do the steps in order; stop and report if
a step in "Ask first" applies.

### 1. Establish a clean baseline

Record the starting commit and the actual Node/npm, JDK and OS versions used.

```bash
npm ci
```

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

(The end-to-end tests need Chromium: set `CHROME_PATH` to an installed one,
or let Playwright use its own.) The APK needs the Android SDK; where it is not
available, rely on the "Android app" CI job and say so. If the baseline is
already failing, fix or report that first: do not start upgrades on a red tree.

### 2. Security

```bash
npm audit
```

- Fix every finding that affects shipped code (anything in the web or Android
  bundles, see the table above).
- Assess build tooling by exposure, not only by whether it ships. Install
  scripts, build tools and Actions can reach signing or publishing secrets.
- The Android libraries and the Docker image are scanned by OSV-Scanner in CI
  (`.github/scripts/scan-dependencies.sh android|image`), which fails on any
  finding. To defer one that cannot be fixed yet, add it to
  `osv-scanner.toml` at the repository root, with a reason and a date to look
  again (it fails again after that date):

  ```toml
  [[IgnoredVulns]]
  id = "GHSA-xxxx-xxxx-xxxx"
  ignoreUntil = 2027-01-31
  reason = "No fixed version yet; only reachable when ... (owner: ..., record: ...)"
  ```

- For every deferred finding, record the advisory, component/version,
  severity, exposure, reason, owner and next review date in the run log.
- Never run `npm audit fix --force`: it makes unreviewed major upgrades.
- Check that the Node.js major in use is still in active or maintenance LTS,
  and that the Android `targetSdkVersion` meets Google's current requirement.

### 3. Updates

```bash
npm outdated
```

- **Dependabot's open pull requests** come first: review, check CI, merge or
  close with a reason (and add an `ignore` to `.github/dependabot.yml` if it
  will keep coming back).
- **Patch and minor updates:** small, independently reviewable groups. Read
  release notes even for minor changes.
- **Major updates:** one package (or one tightly coupled family, such as
  `react` + `react-dom` + `@types/react*`, `vite` + `@vitejs/plugin-react`, or
  all of `@capacitor/*`) per commit. Read the migration guide first and apply
  the code changes it calls for.
- **GitHub Actions:** check each `uses:` for a newer major and for GitHub's
  deprecation notices (old Node runtimes in actions are retired on a schedule).
- **Docker base image and Node:** stay on a supported LTS; verify type
  stripping, `node:sqlite` and `crypto.argon2` before moving majors.

### 4. Deprecations and code patterns

- Read the test and build output for deprecation warnings (Node, Vite, React,
  TypeScript, Gradle, the Android Gradle plugin). Each one is a task.
- Search the type definitions of the main frameworks for `@deprecated` on any
  API this code calls.
- Re-check each item under "Known workarounds" below.

### 5. Verify

| Change area | Required verification |
|---|---|
| Server | Unit tests, web e2e, image build and health check (CI "Server image and web app"). |
| Shared interface or web app | Typecheck, web and mobile e2e. |
| Android dependencies or native code | Mobile e2e and an APK build (CI "Android app"). Changes to `DeviceAuthPlugin`, `AppUpdatePlugin`, signing or the manifest also need an installed-app check on a real phone: register, unlock, lock, update from the previous release. |
| Actions, release or cleanup scripts | actionlint, shellcheck and the script tests (CI "Workflow and script checks"); preview cleanup with its dry-run mode. |

CI skips jobs whose files did not change: a green run with a skipped job is
not evidence that the platform passed. Run it with **Actions → Build → Run
workflow** if needed. Never make a check pass by weakening it: do not skip,
delete or loosen a test.

**Existing data.** Database schema changes are numbered migrations in
`apps/server/src/db.ts`. Never edit a migration that has been released; add a
new one, and test it against a database written by the previous release.

### 6. Deliver

Open one pull request titled `Maintenance: <date>` listing what was upgraded
(from → to), what was deliberately left and why, any code changes made for
deprecations, the verification run (with CI links), and anything still
unverified. Add the run-log row in the same pull request. Label it
`release: patch` so merging it ships the fixes.

## Ask first

Stop and ask the repository owner before doing any of these:

- Changing password hashing, TOTP, session or device-key code or parameters,
  or anything in docs/SECURITY.md.
- Adding a runtime dependency to the server (it has none), or replacing a
  dependency with a different library.
- Loosening a security setting: the CSP, CORS origins, cookie flags, the
  Android manifest (`allowBackup`, cleartext traffic) or `FLAG_SECURE`.
- An upgrade whose migration changes behaviour people see.
- Raising the Android `minSdkVersion` (currently 30, Android 11) or dropping a platform.

## Cryptography review

Every third run or so, check current guidance rather than assuming:

- Argon2id parameters (`DEFAULT_ARGON2` in `apps/server/src/secrets.ts`)
  against OWASP's password storage recommendations. Raising them re-hashes
  each password at its next sign-in.
- Android Keystore and `androidx.biometric` guidance for biometric-bound keys.
- Report findings to the owner; changing parameters is an "Ask first" item.

## Known workarounds

| Where | Workaround | Remove when |
|---|---|---|
| `apps/server/tsconfig.json` (`erasableSyntaxOnly`) | The server runs from TypeScript source via Node's type stripping, which rejects enums and parameter properties. | Keep: it is a guard, not a hack. |
| `apps/mobile/src/device-auth.ts` (`__FAKE_DEVICE__`) | A WebCrypto key stands in for the keystore in the browser e2e build only (`dist-e2e`). | Keep. Must never be enabled in `dist` (check: `grep -c "Test phone" apps/mobile/dist/assets/*.js` prints 0). |

## Run log

Add a row per run, newest first.

| Date | By | Upgraded | Left alone (why) | Notes |
|---|---|---|---|---|
| 2026-11-20 | initial | n/a | n/a | Policy written with the first version. `npm audit`: 0 vulnerabilities. |
