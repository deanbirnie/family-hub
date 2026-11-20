/**
 * Starts the server: reads the environment, prepares the data folder (and
 * stops running as root in Docker), opens the database and listens.
 */
import { join } from 'node:path'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { prepareDataDir } from './privileges.ts'

const config = loadConfig()
prepareDataDir(config.dataDir)
const db = openDb(join(config.dataDir, 'family-hub.db'))
const { server } = createApp({ db, config })

server.listen(config.port, config.host, () => {
  console.log(`Family Hub ${config.version} listening on ${config.host}:${config.port}`)
  if (config.allowHttp) console.warn('FAMILY_HUB_ALLOW_HTTP is on: sign-in works over plain http. Use https for real use.')
  if (!config.webDir) console.log('No web app folder set (FAMILY_HUB_WEB_DIR): serving the API only.')
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
