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
