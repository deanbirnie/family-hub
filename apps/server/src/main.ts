/**
 * Starts the server: reads the environment, prepares the data folder (and
 * stops running as root in Docker), opens the database and listens.
 */
import { dirname, join } from 'node:path'
import { encryptStoredData } from './at-rest.ts'
import { loadServerKey, ServerKeyError } from './server-key.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createMailer, mailConfigFromEnv } from './mail.ts'
import { openDb } from './db.ts'
import { prepareDataDir } from './privileges.ts'
import { maintainFiles } from './file-maintenance.ts'
import { runReminders } from './notifications.ts'

const config = loadConfig()
// Read before dropping root, so a password file (a Docker secret) can be read.
let mailer
try {
  mailer = createMailer(mailConfigFromEnv())
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
prepareDataDir(config.dataDir, [dirname(config.keyFile)])
const db = openDb(join(config.dataDir, 'family-hub.db'))
let serverKey
try {
  serverKey = loadServerKey(config.keyFile, db, config.dataDir)
} catch (e) {
  if (!(e instanceof ServerKeyError)) throw e
  console.error(e.message)
  process.exit(1)
}
const { server, services } = createApp({ db, config, serverKey, mailer })
// Before accepting requests: anything stored before encryption is encrypted now.
await encryptStoredData(services)
await maintainFiles(services)

server.listen(config.port, config.host, () => {
  console.log(`Family Hub ${config.version} listening on ${config.host}:${config.port}`)
  if (config.allowHttp) console.warn('FAMILY_HUB_ALLOW_HTTP is on: sign-in works over plain http. Use https for real use.')
  if (!config.webDir) console.log('No web app folder set (FAMILY_HUB_WEB_DIR): serving the API only.')
  void runReminders(services).catch((e) => console.error('Sending reminders failed', e))
})

const stop = () => {
  server.close(() => {
    db.close()
    process.exit(0)
  })
  // Connections that linger must not keep the container from stopping.
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
