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

## 8. Add the family's contacts (after the Contacts pull request is merged and deployed)

- [ ] 1. Open **Contacts** (parents only) and **Add contact** for the people
      and places you call: family and friends, school, GP and dentist,
      medical aid, insurers, trades.
- [ ] 2. In **Quick Info**, on each person's card, **Choose emergency
      contacts** (first call, and who to try if there is no answer).
- [ ] 3. Optional: link the medical aid scheme and insurers from their
      Quick Info records (Edit → Scheme contact / Insurer or broker contact).
- [ ] 4. Optional: **Export** saves a `.vcf` file your phone's contacts app
      can import. Notes are left out unless you tick the box.

## 9. Turn on reminders (after the notifications pull request is merged and deployed)

- [ ] 1. On the home server, in the folder with `docker-compose.yml`, check
      two lines under `environment:` (copy them from the repository's
      `docker-compose.yml` if your copy is older):

      ```yaml
      TZ: "${TZ:-Africa/Johannesburg}"
      FAMILY_HUB_PUBLIC_URL: "${FAMILY_HUB_PUBLIC_URL:-}"
      ```

      Put your hub's https address after `:-` on the second line, e.g.
      `"${FAMILY_HUB_PUBLIC_URL:-https://hub.example.com}"`. Then:

      ```bash
      docker compose pull && docker compose up -d
      ```

- [ ] 2. In each browser you use the hub in: **Settings → Notifications →
      Turn on notifications in this browser**, allow them when the browser
      asks, then select the send button (paper plane) next to it to send a
      test.
- [ ] 3. Optional: in the same card, choose which reminders you get and from
      what time of day.
- [ ] 4. In **Quick Info**, check passports and vehicles have their expiry
      dates: each one now shows under **Coming up** on the home page.

## 10. Turn on reminders on the phones (after the phone notifications release is installed)

On each parent's phone, once it has the app version with notifications
(Settings → App updates):

- [ ] 1. Optional, for instant notifications: install **ntfy** from F-Droid
      or Google Play and open it once. No account or settings are needed;
      it uses the free ntfy.sh service. (A self-hosted ntfy server can
      replace it later.)
- [ ] 2. In Family Hub: **Settings → Notifications → Turn on notifications
      on this phone**, and allow notifications when Android asks.
- [ ] 3. Check the card says **Daily check: on**, and, if you installed
      ntfy, **Instant notifications: on, through ntfy**. Then select the
      send button (paper plane) next to the phone to send a test.
- [ ] 4. If Android asks about battery use for ntfy, allow it to run in the
      background, so instant notifications are not delayed.

## 11. Add birthdays and family (after the "people and dates" pull request is merged and deployed)

- [ ] 1. In **Contacts**, open each person and **Add a date** for birthdays
      and anniversaries. The year is optional. Choose the reminder (a week
      before and on the day is the default) and, if only one of you should
      get it, who.
- [ ] 2. For friends and family with children: **Add a child** (just a name
      and, if you know it, a birthday), or **Link someone in Contacts**.
- [ ] 3. Create a contact for each of you and the children, and set **One of
      our family in Quick Info**, so your own birthdays are reminded too.
- [ ] 4. Optional: in **Settings → Notifications**, untick **Birthdays,
      anniversaries and other dates** if you only want them on the home page.

## 12. Keep in touch (after the "keeping in touch" pull request is merged and deployed)

- [ ] 1. For people you want to see more of: open them in **Contacts** and
      choose **Stay in touch** (every 2 weeks to every year). After a call
      or visit, select **We spoke today**.
- [ ] 2. Optional: jot down news with **Add a note or life event** (a new
      job, a move, a new baby), and gift ideas with **Add a gift idea**.

## 13. Bring in your contacts (after the "import and export" pull request is merged and deployed)

- [ ] 1. Export your contacts as a vCard (.vcf) file from where they are now:
      **Google Contacts** (contacts.google.com → Export → vCard), your
      **phone's contacts app** (Settings → Export), or **Monica**.
- [ ] 2. In Family Hub: **Contacts → Import**, choose the file, untick anyone
      you don't want (people who look like existing contacts are already
      unticked), choose a category, then **Add**.
- [ ] 3. Optional: **Groups** (e.g. "Christmas card list"), tick people into
      them, then **Export → Address labels** for that group.
- [ ] 4. Optional: **Export → Birthdays and anniversaries (.ics)** and import
      the file into Google Calendar or your phone's calendar. (Phase 4 adds
      a calendar feed that stays up to date by itself.)
- [ ] 5. Please check one exported .vcf in your phone's contacts app and in
      Google Contacts: birthdays without a year and children's names should
      come through. Tell Claude if anything is missing.

## 14. Set up the calendar (after the calendar pull request is merged and deployed)

- [ ] 1. Make sure everyone who should be tagged is a person in **Quick Info**
      (**Add a person**: link each account; add children by name).
- [ ] 2. **Calendar → Colours**: pick a colour for each person.
- [ ] 3. Add a few regular events (school runs, sport) with **New event**,
      tag who they are for (or **Family**), and choose **Repeats**.
- [ ] 4. Optional: **Send out** saves an .ics file your phone's calendar or
      Google Calendar can import; it is a copy, not kept in sync.

## Later steps (added as features land)

- Nothing yet.
