# Back up and restore Family Hub

## The server key: keep it separately

Documents and sign-in secrets in `/data` are encrypted with the **server
key** (`/keys/server.key`, in the `family-hub-keys` volume). It is deliberately
**not** part of the `/data` backup, so a stolen backup cannot be read. That
also means **a backup cannot be restored without the key**.

The hub creates the key on first start. Copy it to your password manager
once (it is one line of text and never changes). Until a parent confirms
this, every parent sees a reminder in the app: **Settings → Server key**
shows the key after a fresh authenticator code, with a button to confirm it
is saved. From the server instead:

```sh
docker compose run --rm --no-deps --entrypoint cat family-hub /keys/server.key
```

If the key is missing or wrong, the hub refuses to start and says so; it
never makes a new key over data encrypted with the old one.

Upgrading from a version before encryption: on first start the hub encrypts
existing documents and sign-in secrets in place. Backups made **before** that
upgrade still contain them in the clear: delete or securely store them.


Back up the **whole `/data` volume together**: `family-hub.db`, any SQLite
WAL files, and `files/`. The files use opaque IDs; the database holds their
names, folders and recycle-bin state. Neither part alone is a complete backup.

Run these commands from the folder containing `docker-compose.yml`. Stop
the hub during the copy so uploads and database changes cannot produce an
inconsistent snapshot. Other containers must not write to the same volume.

## Make a backup

Use a new dated filename each time; the example filename is fixed for clarity.

```sh
mkdir -p backups
docker compose stop family-hub
docker compose run --rm --no-deps --entrypoint sh \
  -v "$PWD/backups:/backup" family-hub \
  -c 'umask 077; tar -czf /backup/family-hub-2026-11-21.tgz -C /data .'
docker compose start family-hub
```

Check that the archive command succeeded. If it fails, start the hub again
and investigate. Keep another copy on a separate disk or machine. The
archive's documents and sign-in secrets are encrypted with the server key,
which is not in it; names, accounts and the audit log are not encrypted, so
still restrict access to it. The helper runs as root, so copying
the archive on the host may require elevated permissions.

## Restore into a new volume

Keep the original volume intact until the restored hub has been checked.
Use the same image version as the backup, or a newer compatible version;
an older server refuses a database with a newer schema.

1. Stop the hub: `docker compose stop family-hub`.
2. Create a **new, empty** volume and extract the archive into it:

   ```sh
   docker volume create family-hub-restored
   docker compose run --rm --no-deps --entrypoint tar \
     -v family-hub-restored:/restore \
     -v "$PWD/backups:/backup:ro" family-hub \
     -xzf /backup/family-hub-2026-11-21.tgz -C /restore
   ```

3. Point the Compose service at that volume by updating its existing
   top-level volume declaration:

   ```yaml
   volumes:
     family-hub-data:
       external: true
       name: family-hub-restored
   ```

4. If the `family-hub-keys` volume is gone too (a new machine), put the key
   back first, from your password manager, saved as `server.key`:

   ```sh
   docker compose run --rm --no-deps -T --entrypoint sh family-hub \
     -c 'umask 077; cat > /keys/server.key' < server.key
   ```

   Then delete that `server.key` copy from the host.
5. Run `docker compose up -d family-hub`. Startup adjusts ownership to the
   configured `PUID` and `PGID`, including document blobs.
6. Sign in, open folders, preview and download known documents, and check
   the recycle bin. Keep the old volume and archive until these checks pass.
   To roll back, stop the hub, restore the original Compose volume
   declaration, then start it again.

An older backup also restores its users, devices and sessions: revoke
anything that should no longer have access. Recycle-bin items older than
30 days are purged at startup, including when starting a restored backup.

## Automated verification

`npm test` copies a stopped database and files to a fresh directory, starts
another server, and verifies accounts, folders, downloads and recycle-bin
restoration.

The image CI job also runs `node .github/scripts/test-backup.mjs family-hub`.
It creates isolated volumes, uploads binary files, stops the source,
archives and extracts `/data`, then starts a new container with a different
`PUID`. It checks the account, folders, exact bytes, recycle-bin recovery and
SQLite integrity. It also checks the archive holds the sign-in secret only
encrypted, and that the restored data refuses to start without its key. It
removes only the containers and volumes it created.
