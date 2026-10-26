import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { listenForPushes } from './live'
import { registerServiceWorker } from './push'

registerServiceWorker()
listenForPushes()

// Android browsers often skip the glass blur on floating bars; CSS gives them a solid one instead.
if (/Android/i.test(navigator.userAgent)) document.documentElement.dataset.platform = 'android'

// Background music was removed; drop its saved setting.
try {
  localStorage.removeItem('music')
} catch {
  // Storage blocked; nothing to clean.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
