import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { listenForPushes } from './live'
import { registerServiceWorker } from './push'

registerServiceWorker()
listenForPushes()

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
