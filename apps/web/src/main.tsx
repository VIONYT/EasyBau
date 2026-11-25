import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyContrast } from './contrast'
import { startOfflineSync } from './offline/client'
import '@opc/ui/tokens.css'
import '@opc/ui/components.css'
import './styles.css'

// Offline shell (ADR 0010): the service worker updates itself; data sync runs in the app.
if ('serviceWorker' in navigator && import.meta.env.PROD) registerSW({ immediate: true })
startOfflineSync()
applyContrast()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
