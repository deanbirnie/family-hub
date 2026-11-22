/** Test helper: what a browser does when a push message arrives (RFC 8291, receiving side). */
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'

export function decryptAsReceiver(message: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = message.subarray(0, 16)
  const idLen = message[20]!
  const asPublic = message.subarray(21, 21 + idLen)
  const body = message.subarray(21 + idLen)
  const ua = createECDH('prime256v1')
  ua.setPrivateKey(uaPrivate)
  const shared = ua.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(body.subarray(body.length - 16))
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])
  if (plain[plain.length - 1] !== 2) throw new Error('missing last-record delimiter')
  return plain.subarray(0, plain.length - 1)
}

