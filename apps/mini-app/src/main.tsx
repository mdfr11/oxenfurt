import './mockEnv.ts';
import { init } from '@telegram-apps/sdk';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { API_BASE } from './lib/api'
import { debug } from './lib/debug'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Providers } from './components/Providers'
import '@telegram-apps/telegram-ui/dist/styles.css';

// Initialize the SDK
try {
  init();
  debug('[oxenfurt] SDK initialized');
} catch (e) {
  console.warn('[oxenfurt] SDK initialization failed (likely non-TMA env):', e);
}

// Print once on boot so DevTools makes the resolved value easy to confirm
// from inside a Telegram WebView. Dev-only so the prod bundle doesn't
// leak the backend URL into the Telegram WebView console.
debug('[oxenfurt] API_BASE =', API_BASE)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Providers>
        <App />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
)
