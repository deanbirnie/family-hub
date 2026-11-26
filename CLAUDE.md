# Notes for Claude

- Actionable work and status: GitHub Issues and Projects; follow `docs/WORKFLOW.md`. Architecture and agreed phase design: `docs/ROADMAP.md`. Dependency and security upkeep:
  `docs/MAINTENANCE.md`. How sign-in works and why: `docs/SECURITY.md`.
- **Owner steps.** `docs/OWNER-STEPS.md` is the owner's checklist of things
  only they can do (keys, secrets, deployment), with exact commands. When a
  change needs the owner to do something, add or update the runbook step and link a separate owner issue in
  the same pull request, and point to it in the pull request and in chat.
  Tick a step only when the owner says it is done.
- **Data protection is decided before building.** `docs/DATA-PROTECTION.md`
  lists everything the hub stores and its tier (E2E family key, server key,
  hashed, plain). Before writing code for a phase or module, add its rows
  there (following "When building a phase") and get the owner's agreement in
  the planning pull request. Never store new data without a row, and never
  move data to a weaker tier without asking.
- Work on a feature branch and open a pull request into `main` when a change
  is done. One phase item (or a coherent part of one) per pull request; link the issue with `Closes #N` if complete, otherwise `Refs #N`.
- **Releases are made by label.** When the owner says a pull request "will be a
  release" (or similar), add the label `release: minor` to it, or
  `release: patch` if it only fixes things (`release: major` only when asked).
  Merging it, or labelling it once merged, starts the release
  (`.github/workflows/release-on-merge.yml`). Do not run the Release workflow
  by hand unless asked. See "Releasing" in `README.md`.
- **Android signing key reminder.** The owner will set up the Android signing
  key (README, "Android signing key") before the first release. Until a
  GitHub release with a `family-hub-*.apk` attached exists, remind the owner
  of this whenever a release is discussed, and before adding any `release: *`
  label (including from the weekly maintenance run, which then says so in its
  pull request). Without the key, a release goes out with no APK. Once a
  release has an APK, drop this item.
- **Server key reminder.** The hub reminds parents in the app (Settings →
  Server key) until one confirms the server key is in their password
  manager. When the owner talks about deploying, upgrading or backups, ask
  whether they have done this yet; never put the key in the repository, an
  issue, a pull request or a chat message.
- Security is not negotiable here: two-factor sign-in on the web and
  biometric unlock on Android are mandatory. Do not add a way around either
  (no "remember this device" that skips the code, no PIN fallback for the
  phone key) unless the owner asks for it explicitly.
- The server has no npm dependencies on purpose (Node 24 built-ins only:
  `node:http`, `node:sqlite`, `crypto.argon2`). Ask before adding one.
- Checks to run before a pull request: `npm run typecheck`, `npm test`,
  `npm run e2e` (web) and `npm run e2e:mobile`. The Android APK only builds
  where the Android SDK is installed (CI's "Android app" job).
