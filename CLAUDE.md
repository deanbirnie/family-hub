# Notes for Claude

- Plan, phases and status: `docs/ROADMAP.md`. Dependency and security upkeep:
  `docs/MAINTENANCE.md`. How sign-in works and why: `docs/SECURITY.md`.
- Work on a feature branch and open a pull request into `main` when a change
  is done. One phase item (or a coherent part of one) per pull request; tick
  it off in `docs/ROADMAP.md` in the same pull request.
- **Releases are made by label.** When the owner says a pull request "will be a
  release" (or similar), add the label `release: minor` to it, or
  `release: patch` if it only fixes things (`release: major` only when asked).
  Merging it, or labelling it once merged, starts the release
  (`.github/workflows/release-on-merge.yml`). Do not run the Release workflow
  by hand unless asked. See "Releasing" in `README.md`.
- Security is not negotiable here: two-factor sign-in on the web and
  biometric unlock on Android are mandatory. Do not add a way around either
  (no "remember this device" that skips the code, no PIN fallback for the
  phone key) unless the owner asks for it explicitly.
- The server has no npm dependencies on purpose (Node 24 built-ins only:
  `node:http`, `node:sqlite`, `crypto.argon2`). Ask before adding one.
- Checks to run before a pull request: `npm run typecheck`, `npm test`,
  `npm run e2e` (web) and `npm run e2e:mobile`. The Android APK only builds
  where the Android SDK is installed (CI's "Android app" job).
