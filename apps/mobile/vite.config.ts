import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = import.meta.dirname
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }
const fakeDevice = process.env.FAMILY_HUB_FAKE_DEVICE === '1'

// Everything the app runs ships inside it. It only connects out: to the
// family's server (any https address the person enters) and to GitHub for
// update checks. Plain http only to this machine, for development.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  'connect-src https: http://localhost:* http://127.0.0.1:*',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const csp = (): Plugin => ({
  name: 'family-hub-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version), __FAKE_DEVICE__: JSON.stringify(fakeDevice) },
  resolve: { alias: { '@family-hub/ui': resolve(root, '../../packages/ui/src/index.tsx') } },
  plugins: [react(), csp()],
  build: { outDir: fakeDevice ? 'dist-e2e' : 'dist', target: 'es2022' },
})
