import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Api, Platform } from '@family-hub/ui'
import { toBase64 } from './device-auth.ts'

const Documents = registerPlugin<{
  download(options: { url: string; token: string; name: string; action: 'save' | 'open' }): Promise<void>
  saveBytes(options: { name: string; data: string; action: 'save' | 'share' }): Promise<void>
  clear(): Promise<void>
}>('Documents')

export function fileDownload(api: Api): Platform['downloadFile'] {
  if (!Capacitor.isNativePlatform()) return undefined
  return async (file, action) => {
    try {
      await Documents.download({ url: `${api.baseUrl}/api/files/${encodeURIComponent(file.id)}/content`, token: api.token, name: file.name, action })
    } catch (e) {
      if ((e as { code?: string }).code === 'UNAUTHENTICATED') api.onSignedOut?.()
      throw e
    }
  }
}

/** Saves an export from the API (only those the native side allows, e.g. vCards) where the person chooses. */
export function exportDownload(api: Api): Platform['saveExport'] {
  if (!Capacitor.isNativePlatform()) return undefined
  return async (path, name) => {
    try {
      await Documents.download({ url: `${api.baseUrl}${path}`, token: api.token, name, action: 'save' })
    } catch (e) {
      if ((e as { code?: string }).code === 'UNAUTHENTICATED') api.onSignedOut?.()
      throw e
    }
  }
}

export const clearDocumentCache = () => {
  if (Capacitor.isNativePlatform()) void Documents.clear().catch(() => undefined)
}

/** Saves or shares a file made on the phone (a PDF report) through Android's save dialog or share sheet. */
export const phoneSaveFile: Platform['saveFile'] = Capacitor.isNativePlatform()
  ? async (file, action) => {
      // Android takes only plain file names.
      const name = file.name.replace(/[^A-Za-z0-9 ._()-]/g, '-')
      await Documents.saveBytes({ name, data: toBase64(file.bytes), action })
    }
  : undefined
