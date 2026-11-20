import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.familyhub.app',
  appName: 'Family Hub',
  webDir: 'dist',
  backgroundColor: '#f6f4f0',
  android: {
    // The app only ever loads its own bundled files; the server is reached
    // with fetch. Plain-http servers are refused (see the manifest).
    allowMixedContent: false,
  },
}

export default config
