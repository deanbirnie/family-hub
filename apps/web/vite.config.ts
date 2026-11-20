import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = import.meta.dirname
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    // The shared interface is consumed as TypeScript source and bundled in.
    alias: { '@family-hub/ui': resolve(root, '../../packages/ui/src/index.tsx') },
  },
  plugins: [react()],
  build: { outDir: 'dist', target: 'es2022' },
  server: {
    // `npm run dev` here and `npm run dev:server` at the root: the page
    // comes from Vite, the API from the server.
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
})
