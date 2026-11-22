import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Api, Platform } from '@family-hub/ui'

const Documents = registerPlugin<{
  download(options: { url: string; token: string; name: string; action: 'save' | 'open' }): Promise<void>
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
