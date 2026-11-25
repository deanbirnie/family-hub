/**
 * Password protection for the PDFs the hub makes (phase 9b: the emergency
 * pack): the PDF 2.0 standard security handler, revision 6 (AES-256, as
 * ISO 32000-2 §7.6.4 describes it), which every current PDF reader opens.
 *
 * A random 256-bit file key encrypts each stream and string (AES-256-CBC, a
 * fresh IV each). The key is stored in the file wrapped twice: once under
 * the user's password (/U, /UE), and once under a random owner password
 * nobody knows (/O, /OE). It runs on the device with Web Crypto: the
 * password never leaves it.
 */

const enc = new TextEncoder()
const subtle = () => globalThis.crypto.subtle
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n))

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const hex = (b: Uint8Array) => `<${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}>`

async function aesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-CBC', false, ['encrypt'])
  return new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, data as BufferSource))
}

/** AES-CBC without padding, for data already a whole number of blocks: Web Crypto always pads, so the padding block is dropped. */
async function aesCbcNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length % 16 !== 0) throw new Error('Not a whole number of AES blocks.')
  return (await aesCbc(key, iv, data)).slice(0, data.length)
}

async function digest(alg: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest(alg, data as BufferSource))
}

/** The password as the standard asks: UTF-8 of its normalised form, at most 127 bytes. */
export function passwordBytes(password: string): Uint8Array {
  return enc.encode(password.normalize('NFKC')).slice(0, 127)
}

/** Algorithm 2.B: the revision 6 hash of a password with a salt (and, for the owner, the /U value). */
export async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
  let k = await digest('SHA-256', concat(password, salt, udata))
  for (let round = 0; ; round++) {
    const block = concat(password, k, udata)
    const k1 = new Uint8Array(block.length * 64)
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length)
    const e = await aesCbcNoPad(k.slice(0, 16), k.slice(16, 32), k1)
    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]!
    k = await digest((['SHA-256', 'SHA-384', 'SHA-512'] as const)[sum % 3]!, e)
    if (round >= 63 && e[e.length - 1]! <= round - 31) break
  }
  return k.slice(0, 32)
}

export interface Encryption {
  /** The /Encrypt dictionary. */
  dictionary: string
  /** The file identifier for the trailer's /ID. */
  id: Uint8Array
  /** Encrypts one stream's or string's bytes: a fresh IV, then AES-256-CBC with padding. */
  encrypt(data: Uint8Array): Promise<Uint8Array>
  hex: (b: Uint8Array) => string
}

/** Everything needed to write a file only `password` opens. Printing and copying stay allowed once it is open. */
export async function aes256(password: string): Promise<Encryption> {
  const fileKey = random(32)
  const user = passwordBytes(password)
  const owner = random(32) // nobody knows it: the user password is the way in
  const zero = new Uint8Array(16)

  const uValidation = random(8)
  const uKeySalt = random(8)
  const u = concat(await hash2B(user, uValidation), uValidation, uKeySalt)
  const ue = await aesCbcNoPad(await hash2B(user, uKeySalt), zero, fileKey)

  const oValidation = random(8)
  const oKeySalt = random(8)
  const o = concat(await hash2B(owner, oValidation, u), oValidation, oKeySalt)
  const oe = await aesCbcNoPad(await hash2B(owner, oKeySalt, u), zero, fileKey)

  // Permissions: all allowed (-4 has every bit set but the two reserved low ones).
  const p = -4
  const perms = new Uint8Array(16)
  new DataView(perms.buffer).setInt32(0, p, true)
  perms.set([0xff, 0xff, 0xff, 0xff], 4)
  perms.set(enc.encode('Tadb'), 8) // T: the metadata is encrypted too
  perms.set(random(4), 12)
  const permsEnc = await aesCbcNoPad(fileKey, zero, perms) // one block: CBC with a zero IV is ECB

  return {
    dictionary:
      `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF ` +
      `/O ${hex(o)} /U ${hex(u)} /OE ${hex(oe)} /UE ${hex(ue)} /Perms ${hex(permsEnc)} /P ${p} /EncryptMetadata true >>`,
    id: random(16),
    encrypt: async (data) => {
      const iv = random(16)
      return concat(iv, await aesCbc(fileKey, iv, data))
    },
    hex,
  }
}
