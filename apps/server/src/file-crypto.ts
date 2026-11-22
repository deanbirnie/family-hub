/**
 * Document contents encrypted with the server key, in a streaming format so
 * uploads and downloads of any size never need to fit in memory.
 *
 *   header:  "FHF1" (4 bytes) | salt (16 bytes)
 *   chunks:  AES-256-GCM(chunk) | tag (16 bytes), one per 64 KiB of the document
 *
 * The key is unique per document (HKDF of the server key with the document's
 * ID and random salt). Chunk i uses nonce = i, and its associated data is the
 * header, i, and whether it is the last chunk. So chunks cannot be reordered,
 * dropped, swapped between documents, or the document cut short without
 * decryption failing. An empty document is one empty final chunk.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { ServerKey } from './server-key.ts'

export const MAGIC = Buffer.from('FHF1')
export const HEADER_BYTES = MAGIC.length + 16
export const CHUNK_BYTES = 64 * 1024
const TAG_BYTES = 16

const nonce = (index: number) => {
  const n = Buffer.alloc(12)
  n.writeBigUInt64BE(BigInt(index), 4)
  return n
}
const aad = (header: Buffer, index: number, last: boolean) => {
  const a = Buffer.alloc(header.length + 9)
  header.copy(a)
  a.writeBigUInt64BE(BigInt(index), header.length)
  a[header.length + 8] = last ? 1 : 0
  return a
}

function sealChunk(key: Buffer, header: Buffer, index: number, last: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(index))
  cipher.setAAD(aad(header, index, last))
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

function openChunk(key: Buffer, header: Buffer, index: number, last: boolean, sealed: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce(index))
  decipher.setAAD(aad(header, index, last))
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()])
}

/** The size on disk of a document of `size` bytes. */
export const encryptedSize = (size: number) => HEADER_BYTES + Math.max(1, Math.ceil(size / CHUNK_BYTES)) * TAG_BYTES + size

/**
 * Writes a document encrypted to `out`, as its bytes arrive. Holds back at
 * most one chunk, because the last chunk is marked as last.
 */
export class FileEncryptor {
  private key: Buffer
  private header: Buffer
  private out: FileHandle
  private pending: Buffer = Buffer.alloc(0)
  private index = 0
  private started = false

  constructor(serverKey: ServerKey, fileId: string, out: FileHandle) {
    const salt = randomBytes(16)
    this.header = Buffer.concat([MAGIC, salt])
    this.key = serverKey.fileKey(fileId, salt)
    this.out = out
  }

  async write(data: Buffer): Promise<void> {
    if (!this.started) {
      await this.out.write(this.header)
      this.started = true
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data
    while (this.pending.length > CHUNK_BYTES) {
      await this.out.write(sealChunk(this.key, this.header, this.index++, false, this.pending.subarray(0, CHUNK_BYTES)))
      this.pending = this.pending.subarray(CHUNK_BYTES)
    }
  }

  async finish(): Promise<void> {
    if (!this.started) {
      await this.out.write(this.header)
      this.started = true
    }
    await this.out.write(sealChunk(this.key, this.header, this.index++, true, this.pending))
    this.pending = Buffer.alloc(0)
  }
}

export class DamagedFileError extends Error {}

/**
 * Reads an encrypted document from `handle` (of `diskSize` bytes), yielding
 * its decrypted contents chunk by chunk. Throws DamagedFileError if anything
 * was altered, truncated or belongs to another document.
 */
export async function* decryptFile(serverKey: ServerKey, fileId: string, handle: FileHandle, diskSize: number): AsyncGenerator<Buffer> {
  const header = Buffer.alloc(HEADER_BYTES)
  const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
  if (bytesRead !== HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new DamagedFileError('Not an encrypted document.')
  const key = serverKey.fileKey(fileId, header.subarray(MAGIC.length))
  const record = CHUNK_BYTES + TAG_BYTES
  let position = HEADER_BYTES
  let index = 0
  for (;;) {
    const remaining = diskSize - position
    if (remaining < TAG_BYTES) throw new DamagedFileError('The document is cut short.')
    const last = remaining <= record
    const length = last ? remaining : record
    const sealed = Buffer.alloc(length)
    const read = await handle.read(sealed, 0, length, position)
    if (read.bytesRead !== length) throw new DamagedFileError('The document is cut short.')
    let plain: Buffer
    try {
      plain = openChunk(key, header, index, last, sealed)
    } catch {
      throw new DamagedFileError('The document has been altered or does not belong here.')
    }
    yield plain
    if (last) return
    position += length
    index++
  }
}

/** True if `handle` holds this document, encrypted with this key (checks the first chunk). */
export async function isEncryptedFile(serverKey: ServerKey, fileId: string, handle: FileHandle, diskSize: number): Promise<boolean> {
  try {
    const chunks = decryptFile(serverKey, fileId, handle, diskSize)
    await chunks.next()
    await chunks.return(undefined)
    return true
  } catch {
    return false
  }
}
