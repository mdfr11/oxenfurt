import './mockEnv.ts';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { API_BASE } from './lib/api'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Providers } from './components/Providers'
import '@telegram-apps/telegram-ui/dist/styles.css';

// Print once on boot so DevTools makes the resolved value easy to confirm
// from inside a Telegram WebView — saved a lot of time during the
// "empty-string-VITE_API_URL" debug session.
console.info('[oxenfurt] API_BASE =', API_BASE)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Providers>
        <App />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
)
