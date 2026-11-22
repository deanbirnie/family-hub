# Owner steps

Things only you (the owner) can do, in order, with exact steps. Claude keeps
this list current: new steps are added here when a pull request needs one,
and a step is ticked once you say it is done.

Two things must end up in your **password manager**, each as a secure note:

| Note name | What it is | Without it |
|---|---|---|
| **Family Hub server key** | Encrypts documents and sign-in secrets on the server (step 3). | A backup cannot be restored. |
| **Family Hub recovery key** | Opens the family vault (Quick Info) if every unlocked device is lost (step 6). | Quick Info is gone for good if all your devices are lost. |

Never paste either into a chat, an issue or a pull request.

---

## 1. Set up the Android signing key (once, before the first release)

Without this, releases have no Android app. Full background: README,
"Android signing key". On any machine with Docker:

- [ ] 1. Create the keystore. Choose a long password and use it in **both**
      places:

      ```bash
      docker run --rm -v "$PWD":/out eclipse-temurin:21-jdk keytool -genkeypair -keystore /out/family-hub-release.jks -alias family-hub -keyalg RSA -keysize 4096 -validity 10000 -storepass 'CHOOSE-A-PASSWORD' -keypass 'CHOOSE-A-PASSWORD' -dname "CN=Family Hub"
      ```

- [ ] 2. Print it as one line of text and copy the output:

      ```bash
      base64 -w0 family-hub-release.jks
      ```

- [ ] 3. Print its fingerprint and copy the value after `SHA256:`:

      ```bash
      docker run --rm -v "$PWD":/out eclipse-temurin:21-jdk keytool -list -v -keystore /out/family-hub-release.jks -alias family-hub -storepass 'CHOOSE-A-PASSWORD'
      ```

- [ ] 4. On GitHub: **deanbirnie/family-hub → Settings → Secrets and
      variables → Actions**.
      - **Secrets** tab → New repository secret, four times:
        `ANDROID_KEYSTORE_BASE64` (step 2's output), `ANDROID_KEYSTORE_PASSWORD`
        (your password), `ANDROID_KEY_ALIAS` (`family-hub`),
        `ANDROID_KEY_PASSWORD` (the same password).
      - **Variables** tab → New repository variable:
        `ANDROID_RELEASE_CERT_SHA256` (step 3's fingerprint).
- [ ] 5. Save `family-hub-release.jks` and its password in your password
      manager (as an attachment, or the step 2 text), then delete the local
      file. If it is lost, future versions cannot install over the app on
      your phones.
- [ ] 6. Tell Claude it is done, then ask for a release (step 2).

## 2. Make the first release

- [ ] 1. Tell Claude which merged pull request should be the release, or
      say "release what's on main". Claude adds the `release: minor` label.
- [ ] 2. Wait for **Actions → Release** to finish (about 10 minutes), then
      check **Releases** shows `family-hub-X.Y.Z.apk`.

## 3. Run the hub at home and save the server key

On the home server, with Docker:

- [ ] 1. Copy `docker-compose.yml` from the repository into a folder, e.g.
      `~/family-hub/`. Until the first release exists, change the image tag
      from `latest` to `edge` in that file.
- [ ] 2. Start it:

      ```bash
      docker compose up -d
      ```

- [ ] 3. Point your reverse proxy's https address (e.g.
      `https://hub.example.com`) at `http://127.0.0.1:8080`. Sign-in only
      works over https.
- [ ] 4. Open the https address. Set up the family and your account, then
      two-factor sign-in with your authenticator app. Save the recovery codes
      it shows in your password manager ("Family Hub recovery codes").
- [ ] 5. **Save the server key.** The yellow banner says "Save the server key
      to your password manager". Select **Save it now**, enter a fresh code
      from your authenticator app, select **Copy key**, and paste it into a
      new secure note named **Family Hub server key**. Then select **I've
      saved it in my password manager**.
- [ ] 6. Make a first backup: README → "Back up", or docs/BACKUPS.md.

## 4. Install the app on your phone

- [ ] 1. On the phone, open the latest release on GitHub and tap
      `family-hub-X.Y.Z.apk`. Allow installing from the browser when asked.
- [ ] 2. Open Family Hub, enter the https address, sign in with your password
      and an authenticator code.
- [ ] 3. Turn on fingerprint unlock when asked.

## 5. Invite your partner

- [ ] 1. In the hub: **Family → Invite someone**, choose **Parent**, and send
      the link privately (e.g. a direct message).
- [ ] 2. They open it in a browser, choose a username and password, and set
      up two-factor sign-in, then install the app (step 4) on their phone.

## 6. Set up the family vault (after pull request 1b is merged and deployed)

The vault holds Quick Info, end-to-end encrypted: the server cannot read it.

- [ ] 1. On your phone or in a browser: **Settings → Family vault → Set up
      the family vault**.
- [ ] 2. It shows the **recovery key** once. Select **Copy**, paste it into a
      new secure note named **Family Hub recovery key**, then tick "I have
      saved the recovery key" and continue.
- [ ] 3. In a browser, select **Add a passkey** so that browser can unlock
      the vault (Windows Hello, Touch ID, your phone or a security key). On
      the phone, the vault opens with your fingerprint automatically.
- [ ] 4. **Give your partner access.** On their phone or browser: **Settings
      → Family vault → Get access from another device**. It shows a code
      and six words. On your unlocked device: **Settings → Family vault →
      Approve a new device**, type the code, check the six words match on
      both screens, and approve.
- [ ] 5. Repeat 4 for any other browser or phone either of you uses.

## 7. Fill in Quick Info (after the Quick Info pull request is merged and deployed)

- [ ] 1. Open **Quick Info** (parents only). If the vault is locked, open it
      first (fingerprint on the phone, passkey in a browser).
- [ ] 2. **Add a person** for each of you (pick your names to link your
      accounts) and for each child (type their name).
- [ ] 3. Fill in **Personal details**, **Medical aid**, **Passport**,
      **Vehicles** and **Policies**, and the **Household** address. ID
      numbers are checked as you type, and the date of birth fills in from
      them.
- [ ] 4. Optional: upload scans (ID, passport) to **Files** first, then link
      them from the record's Edit screen. Files are visible to every family
      member, so only upload what everyone may see.

## Later steps (added as features land)

- Notifications (phase 2, part 4): installing ntfy on each phone.
