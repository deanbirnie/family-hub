// Exercises a stopped-volume tar backup in isolated fresh containers.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { totpAt } from '../../apps/server/src/totp.ts'

const image = process.argv[2] || 'family-hub'
const prefix = `family-hub-backup-${randomUUID()}`
const source = `${prefix}-source`, restored = `${prefix}-restored`
const sourceVolume = `${prefix}-source-data`, restoredVolume = `${prefix}-restored-data`
// The server key is kept apart from /data (and from the backup), as in docker-compose.yml.
const keyVolume = `${prefix}-keys`, emptyKeyVolume = `${prefix}-no-keys`
const backupDir = mkdtempSync(join(tmpdir(), 'family-hub-backup-'))
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim()
let base = '', cookie = ''
async function call(path, method = 'GET', body) {
  const raw = Buffer.isBuffer(body)
  const res = await fetch(base + path, { method, headers: { cookie, 'x-requested-with': 'family-hub', ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) })
  for (const value of res.headers.getSetCookie()) cookie = value.split(';')[0]
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res
}
const json = async (path, method = 'GET', body) => (await call(path, method, body)).json()
async function start(name, volume, uid, keys = keyVolume) {
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-e', `PUID=${uid}`, '-e', 'PGID=100', '-v', `${volume}:/data`, '-v', `${keys}:/keys`, image)
  base = `http://${docker('port', name, '8080/tcp')}`
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Backup test container did not start: ${docker('logs', name)}`)
}

try {
  docker('volume', 'create', sourceVolume)
  docker('volume', 'create', restoredVolume)
  docker('volume', 'create', keyVolume)
  docker('volume', 'create', emptyKeyVolume)
  await start(source, sourceVolume, 99)
  await json('/api/setup', 'POST', { familyName: 'Backup test', username: 'parent', displayName: 'Parent', password: 'backup-validation-passphrase' })
  const { secret } = await json('/api/auth/totp/setup', 'POST', {})
  await json('/api/auth/totp/confirm', 'POST', { code: totpAt(secret, Date.now()) })
  const { item: folder } = await json('/api/files/folders', 'POST', { name: 'Policies' })
  const bytes = Buffer.from([0, 255, 128, 42, 10, 13])
  const upload = async (name) => (await json(`/api/files/upload?${new URLSearchParams({ name, parent: folder.id })}`, 'POST', bytes)).item
  const active = await upload('active.bin'), deleted = await upload('deleted.bin')
  await call(`/api/files/${deleted.id}`, 'DELETE')
  docker('stop', source)
  docker('run', '--rm', '-v', `${sourceVolume}:/data:ro`, '-v', `${backupDir}:/backup`, '--entrypoint', 'sh', image, '-c', 'umask 077; tar -czf /backup/family-hub.tgz -C /data .')
  docker('run', '--rm', '-v', `${restoredVolume}:/data`, '-v', `${backupDir}:/backup:ro`, '--entrypoint', 'tar', image, '-xzf', '/backup/family-hub.tgz', '-C', '/data')
  // The backup holds only ciphertext: the sign-in secret is not in it in the clear.
  const archive = docker('run', '--rm', '-v', `${backupDir}:/backup:ro`, '--entrypoint', 'sh', image, '-c', 'cd /tmp && tar -xzf /backup/family-hub.tgz && cat files/* && echo && node --input-type=module -e "import {DatabaseSync} from \'node:sqlite\'; console.log(new DatabaseSync(\'family-hub.db\',{readOnly:true}).prepare(\'SELECT totp_secret FROM users\').get().totp_secret)"')
  assert.ok(!archive.includes(secret), 'the backup contains the authenticator secret in the clear')
  assert.ok(archive.split('\n').pop().startsWith('s1.'), 'the authenticator secret is not sealed')
  // Restored without its key, the server refuses to start rather than make a new one.
  let refusal = ''
  try {
    docker('run', '--rm', '--name', `${restored}-nokey`, '-e', 'PUID=1001', '-e', 'PGID=100', '-v', `${restoredVolume}:/data`, '-v', `${emptyKeyVolume}:/keys`, image)
  } catch (e) {
    refusal = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  assert.match(refusal, /server key file .* is missing/, 'a restore without its key must refuse to start')
  await start(restored, restoredVolume, 1001)
  assert.equal((await json('/api/auth/session')).user.username, 'parent')
  assert.deepEqual((await json(`/api/files?parent=${folder.id}`)).items.map((f) => f.id), [active.id])
  assert.equal((await json('/api/files/trash')).items[0].id, deleted.id)
  await json(`/api/files/${deleted.id}/restore`, 'POST', {})
  for (const item of [active, deleted]) assert.deepEqual(Buffer.from(await (await call(`/api/files/${item.id}/content`)).arrayBuffer()), bytes)
  const integrity = docker('exec', restored, 'node', '--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/family-hub.db',{readOnly:true}); console.log(Object.values(db.prepare('PRAGMA integrity_check').get())[0]); db.close()")
  assert.equal(integrity, 'ok')
  console.log('Container backup and restore: passed (accounts, folders, bytes, recycle bin, changed PUID, encrypted at rest, refuses a missing key)')
} finally {
  for (const name of [source, restored, `${restored}-nokey`]) { try { docker('rm', '-f', name) } catch { /* already absent */ } }
  for (const volume of [sourceVolume, restoredVolume, keyVolume, emptyKeyVolume]) { try { docker('volume', 'rm', volume) } catch { /* already absent */ } }
  rmSync(backupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
