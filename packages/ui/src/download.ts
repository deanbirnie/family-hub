/** Saving something the API produces (a vCard export) on this device. */
import type { Platform } from './platform.ts'

export async function saveFromApi(platform: Platform, path: string, name: string): Promise<void> {
  if (platform.saveExport) {
    await platform.saveExport(path, name)
    return
  }
  const url = URL.createObjectURL(await platform.api.blob(path))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Whether this device can hand a file made here to another app (a share sheet). */
export function canShareFile(platform: Platform, name: string): boolean {
  if (platform.saveFile) return true
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([], name, { type: 'application/pdf' })] })
  } catch {
    return false
  }
}

/** Saves, or shares, a file made on this device (a PDF report). */
export async function saveMadeFile(platform: Platform, file: { name: string; bytes: Uint8Array }, action: 'save' | 'share'): Promise<void> {
  if (platform.saveFile) return platform.saveFile(file, action)
  const blob = new Blob([file.bytes as BlobPart], { type: 'application/pdf' })
  if (action === 'share') {
    try {
      await navigator.share({ files: [new File([blob], file.name, { type: 'application/pdf' })], title: file.name })
      return
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      // No share sheet after all: save it instead.
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
