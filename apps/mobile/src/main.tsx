import { setRouteMode } from '@family-hub/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MobileGate } from './MobileGate.tsx'

// Hash routes work however the app's files are served.
setRouteMode('hash')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileGate version={__APP_VERSION__} />
  </StrictMode>,
)
