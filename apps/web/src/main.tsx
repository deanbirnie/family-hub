import { Api, describeAgent, setRouteMode, WebGate, type Platform } from '@family-hub/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

setRouteMode('path')

const platform: Platform = {
  kind: 'web',
  version: __APP_VERSION__,
  api: new Api({ baseUrl: '', client: 'web' }),
  deviceLabel: describeAgent(navigator.userAgent),
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebGate platform={platform} />
  </StrictMode>,
)
