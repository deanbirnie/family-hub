import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

/** PDF resources ship locally with both apps; no external font/CDN requests. */
export function pdfAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const assets = new Map<string, Buffer>()
  assets.set('pdf-assets/pdf.worker.js', readFileSync(join(root, 'build/pdf.worker.min.mjs')))
  for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const file of readdirSync(join(root, folder), { withFileTypes: true })) {
      if (file.isFile()) assets.set(`pdf-assets/${folder}/${file.name}`, readFileSync(join(root, folder, file.name)))
    }
  }
  return {
    name: 'family-hub-pdf-assets',
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source })
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!.replace(/^\//, '')
        const data = assets.get(path)
        if (!data) { next(); return }
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(data)
      })
    },
  }
}
