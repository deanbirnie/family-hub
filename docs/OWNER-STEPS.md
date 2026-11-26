# Owner steps

Things only you (the owner) can do, in order, with exact steps. Claude keeps
this list current: new steps are added here when a pull request needs one,
and a step is ticked once you say it is done. Track actionable owner work in issues #74–77 (bank formats #61); this file is the command-by-command runbook. See [WORKFLOW.md](WORKFLOW.md).

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

## 15. Calendar reminders and children on contacts (after the "reminders and birthdays" pull request is merged and deployed)

- [ ] 1. Everyone (members too): **Settings → Notifications** → turn
      notifications on for this browser or phone, and keep **Calendar
      events** ticked.
- [ ] 2. On events that matter, tick **Remind** (e.g. 1 hour before). It
      goes to the people tagged who have an account; for Family events and
      children's events, to both parents.
- [ ] 3. For friends' young children: open the friend in **Contacts** →
      **Add a child**, with a birthday. If the friend's partner is linked,
      tick "Also … 's child" so it shows under both. Birthdays then show on
      the calendar and remind you a week before.

## 16. Outside calendars (after the "outside calendars" pull request is merged and deployed)

- [ ] 1. **Calendar → Outside calendars**: public holidays are on; untick if
      you don't want them.
- [ ] 2. For the school's or club's calendar: copy its calendar link (often
      "Subscribe", "iCal" or "webcal"), then **Follow a calendar**: name it,
      paste the link, tag who it is for. Its events wait in the **Inbox**:
      accept the ones you want. Tick "Always accept" only for calendars you
      trust.
- [ ] 3. To bring your existing Google Calendar across once: in Google
      Calendar, Settings → Import & export → Export, unzip, then **Import a
      file once** here and accept from the Inbox.
- [ ] 4. The home server must be able to reach those calendar sites over
      the internet (it fetches them every 6 hours).

## 17. Start the health records (after the Health pull request is merged and deployed)

- [ ] 1. Add your GP, paediatrician, dentist and pharmacy to **Contacts**
      first.
- [ ] 2. **Health** (open the vault if asked): for each person, add
      allergies (mark severe ones), conditions, blood type and care notes,
      doctors, and current medicines (tick "chronic" for repeat scripts).
- [ ] 3. Add past visits, operations and results under **History**;
      documents you upload there go into the **Health** folder in Files,
      which the children cannot see.

## 18. Vaccinations, growth and check-ups (after the second Health pull request is merged and deployed)

- [ ] 1. For each child: **Health → Vaccinations**: tap each dose in the
      schedule and record it from their Road-to-Health booklet (given, missed,
      held back, or not applicable). Check the built-in schedule against the
      booklet; add anything extra with +.
- [ ] 2. **Growth**: add the latest height and weight, and under **Blood type
      and care notes** choose how often to be reminded to measure.
- [ ] 3. **Regular check-ups**: add the dentist and eye tests with when they
      were last done.
- [ ] 4. For chronic medicines, fill in **Next repeat due** and **Script
      expires** to be reminded.
- [ ] 5. **Settings → Notifications**: keep **Health reminders** ticked.

## 19. Try an episode (after the Episodes pull request is merged and deployed)

- [ ] 1. On each parent's phone, check **Settings → Notifications** shows
      instant notifications through ntfy. Dose reminders come to the minute
      only that way (or in a browser with notifications on); the phone's
      daily check alone is too late for a dose.
- [ ] 2. Try it once with a made-up episode: **Health → Start an episode**,
      add a medicine plan due in a few minutes, and check both phones get
      "A medicine is due". Then delete the episode.

## 20. Reports and the emergency card (after the reports pull request is merged and deployed)

- [ ] 1. In a browser: **Health → Visit summary (PDF)** for one person.
      Check it against what you know, and keep one for the next doctor's
      visit.
- [ ] 2. The emergency card is in the Android app, so it reaches the phones
      with the next release (which needs the Android signing key, step 1,
      first). After updating, on **each parent's phone**: open **Health**
      once with the vault open (this makes the card), then lock the app,
      turn on flight mode, and tap **Emergency card** on the locked screen.
      It should open with your fingerprint.
- [ ] 3. Open Health on each phone now and then (and after changes), so the
      card stays current. It shows when it was last updated.

## 21. Bank export layouts (before the budget, 6c)

- [ ] 1. In ABSA's and Capitec's online banking, export a statement as CSV
      (a short date range is enough).
- [ ] 2. Open each in a text editor and copy only **the first line (the
      column headings)** into the chat, plus **one made-up line** in the same
      layout (change every number and description). Never send real
      transactions or account numbers.

## 22. Bills, subscriptions and invoices (after the 6a pull request is merged and deployed)

- [ ] 1. **Bills & budget → Accounts:** add each account you pay from, as
      the bank and a nickname only (never the account number).
- [ ] 2. **Bills:** add the regular ones (rates and levies, insurance,
      school fees, the cellphone and internet contracts, loans). For
      contracts, fill in the end date and the notice period, so you are
      reminded before the last day to cancel.
- [ ] 3. **Subscriptions:** add streaming, apps, cloud storage, the gym, and
      any free trials (with the trial end date).
- [ ] 4. **Invoices:** add unpaid ones as they arrive, with the PDF.
- [ ] 5. **Settings → Notifications:** keep **Bills, subscriptions and
      invoices** ticked.

## 23. Home and car (after the 6b pull request is merged and deployed)

- [ ] 1. **Home & car → Add a vehicle** for each car, linked to its Quick
      Info vehicle (open the family vault first), with the service interval.
      Then **Log a service or repair** for the last service, with the
      odometer, so the next one can be worked out. Add an odometer reading
      now and then.
- [ ] 2. **Warranties:** add the appliances and electronics whose warranties
      matter, with the receipt and manual.
- [ ] 3. **Maintenance:** tap the suggestions that apply (geyser, gutters,
      smoke detectors, …) and fill in when each was last done.
- [ ] 4. Add the tradespeople you use to Contacts, so their numbers show
      with the jobs.
- [ ] 5. **Settings → Notifications:** keep **Home and car** ticked.

## 24. The budget (after the 6c budget pull request is merged and deployed)

- [ ] 1. **Bills & budget → Budget → Change categories:** rename, remove or
      add categories to suit you, put them in order of priority, and fill in
      what is already saved in the funds that save up (emergency fund,
      holidays, car upkeep, …).
- [ ] 2. **Debt:** add each debt (not the home loan) with its balance,
      minimum payment and interest rate, and set the extra you can put
      towards the smallest each month.
- [ ] 3. **Planned:** add the costs you know are coming (school camp,
      uniforms, Christmas, the car service), with the month and, for bigger
      ones, the month to start saving.
- [ ] 4. Before each month starts, open **Budget**, plan the month, add the
      income and give every rand a job until "left to plan" is zero. (You are
      reminded from the 25th.)

## 25. Importing from the bank (after the import pull request is merged and deployed)

- [ ] 1. In online banking, export a statement as **CSV** (ABSA and
      Capitec both offer it), then **Bills & budget → Budget → Import**,
      choose the account and the file.
- [ ] 2. The first time for each bank, check which column is which (the
      hub guesses from the headings) and the dates and amounts in the
      preview, then import. It is remembered for next time.
- [ ] 3. Put each new transaction in a category. When the hub offers
      "Always put anything with … in …?", say yes for shops you use often,
      so later imports sort themselves.
- [ ] 4. Export overlapping dates without worrying: transactions already in
      the hub are skipped.

## 26. School (after the 7a pull request is merged and deployed)

- [ ] 1. Add the teachers, the school office, aftercare, coaches and the
      lift club to **Contacts** first.
- [ ] 2. **School → Add a child** for each child at school, with the school,
      the class and the term dates. Add the fees as a bill in **Bills &
      budget** and link it (Edit).
- [ ] 3. Link the school contacts with their roles, add the extra-murals
      (they go on the calendar weekly for their term) and any reminders.
- [ ] 4. **Plan a school cost** for what you know is coming (camp, uniform,
      photos), and **Add dates from school** each time the school sends
      them.
- [ ] 5. **Settings → Notifications:** keep **School reminders** ticked.

## 27. School paperwork and lists (after the 7b pull request is merged and deployed)

- [ ] 1. **School → Plan the year:** work through the checklist; each step
      has a "Do it" button.
- [ ] 2. Add forms and permission slips as they come home, with the form
      itself; tick them when done.
- [ ] 3. Add the school's stationery and uniform lists and tick them off as
      you buy; copy them for next year or the next child.
- [ ] 4. Set up **What to bring** once (the swimming bag on Tuesdays, the
      library book on Fridays).

## 28. Wishlists (after the 8a pull request is merged and deployed)

- [ ] 1. **Wishlists → My list:** add a few things, with a link where it
      is from a shop. Ask everyone with an account to do the same.
- [ ] 2. Add the children's lists (you keep those for children without an
      account) and everyone's **Sizes**.
- [ ] 3. Check the surprise holds: mark something on your partner's list as
      "I'm getting this", and ask them to look at their list. They should
      see the item but nothing about who is getting it.

## 29. Wishlist share links (after the 8b pull request is merged and deployed)

- [ ] 1. Share links open the hub's https address, so grandparents need to
      reach it from outside your home (through your reverse proxy or tunnel;
      see "Running it at home" in the README). If the hub is only reachable
      at home, the links only work there.
- [ ] 2. **Wishlists → a child's list → Make a link**, copy it and send it
      to the grandparents. It is shown once; "Make a new link" replaces it.
- [ ] 3. Open the link in a private browser window, mark something, and
      check it shows on the child's list with "(via the link)".

## 30. The gift planner (after the 8c pull request is merged and deployed)

- [ ] 1. **Wishlists → Gift planner → Add a gift idea** for the people who
      matter, choosing the day it is for (their birthday, Christmas, or
      another day). Only people with ideas are in the planner.
- [ ] 2. As the day nears, tap **Bought**, **Wrapped** and **Given**.
- [ ] 3. **Plan in the budget** on Christmas (and any big birthday), so the
      month's budget has the gifts in it.

## 31. Email from the hub, and the trusted parties (after the 9a pull request is merged and deployed)

The hub sends email in an emergency through an account you give it. A
separate Gmail account just for the hub is best (e.g. `ourfamily.hub@gmail.com`),
so the app password cannot read your own mail.

- [ ] 1. In that Google account: turn on 2-Step Verification, then open
      <https://myaccount.google.com/apppasswords>, make an app password named
      "Family Hub" and copy the 16 letters.
- [ ] 2. On the server, next to `docker-compose.yml`, add to the `.env` file
      (create it if there is none; it must not go into git):

      ```
      FAMILY_HUB_SMTP_HOST=smtp.gmail.com
      FAMILY_HUB_SMTP_PORT=465
      FAMILY_HUB_SMTP_USER=ourfamily.hub@gmail.com
      FAMILY_HUB_SMTP_PASSWORD=the16letterapppassword
      ```

      Then restrict who can read it and restart the hub:

      ```bash
      chmod 600 .env
      ```

      ```bash
      docker compose up -d
      ```

      (Or put the password in a Docker secret and set
      `FAMILY_HUB_SMTP_PASSWORD_FILE` to its path instead.)
- [ ] 3. **Settings → In case of emergency → Send a test** to your own
      address, and check it arrived (and is not in spam).
- [ ] 4. Add the trusted parties: at least one **guardian**, and anyone **to
      inform**.
- [ ] 5. **Wait with the letters** until the release pull request (9c) is
      deployed: until then the link in a letter opens nothing. The letters
      use the pack's password (step 32).

## 32. The emergency pack (after the 9b pull request is merged and deployed)

- [ ] 1. **Settings → In case of emergency → The pack:** open the vault,
      then **Choose the password**. Save it in your password manager (both
      of you need to reach it), then tick that you have and save. The pack
      is made straight away.
- [ ] 2. **Our instructions → Write them:** the children's routines and
      care, who to call, where the will and policies are, debit orders to
      cancel, the password manager's emergency access, your wishes. Fill in
      what you can; you can come back to it.
- [ ] 3. **Download, to keep with the will**, open it with the password to
      check it, print it and keep it with the will. You are reminded a year
      later to print a fresh copy.
- [ ] 4. Nothing else to do: whenever one of you opens the vault, the pack
      is remade (at most once a day).

## 33. Releasing the pack (after the 9c pull request is merged and deployed)

- [ ] 1. **Settings → In case of emergency → When the pack is sent:** each
      of you adds your own email for warnings, and you choose the waiting
      times together (or keep 3 days, 24 hours, 7 days, 3 days and 3 days).
- [ ] 2. Make sure each parent's phone has notifications on: a request or
      a check-in also comes as a notification.
- [ ] 3. Make and give the letters now (step 31.5): their links work.
- [ ] 4. Try it once: open a guardian's link from their letter on another
      device, ask for the pack, check you are both told, and cancel it
      ("All is well"). The guardian is emailed that all is well.

## 34. Home safe and Arrived (after the 10a pull request is merged and deployed)

- [ ] 1. Update the app on both phones (and the children's, if they have
      the app). The first **Arrived** asks to use the location: allow it
      "while using the app".
- [ ] 2. Check each phone has notifications on and a push app (Settings →
      Notifications shows it): without one, a phone only checks once a day,
      too late for "home safe".
- [ ] 3. Try it: tap **Home safe** on one phone and check the other is told.

## 35. SOS (after the 10b pull request is merged and deployed)

- [ ] 1. Update the app on the phones. The first **SOS** asks for the
      location (allow it); it shows "SOS is on" as a notification while it
      runs.
- [ ] 2. On some phones (Samsung, Xiaomi, Huawei) battery saving stops
      apps in the background: Settings → Apps → Family Hub → Battery →
      **Unrestricted**, so an SOS keeps sending with the screen off.
- [ ] 3. Try it once together: press **SOS**, check the other phone is
      alerted and sees the location, then **End the SOS → Whoops**.

## Later steps (added as features land)

- Nothing yet.
