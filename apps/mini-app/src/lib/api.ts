// Resolves the API origin once at module load. Three cases:
//   1. VITE_API_URL is set to a non-empty value → use it verbatim.
//   2. import.meta.env.DEV → talk to the dev backend on localhost:3000.
//   3. Prod default → same-origin reverse proxy at `<origin>/api`.
//
// The empty-string case is treated as "unset" deliberately — deploy.sh
// historically passed `VITE_API_URL=''` to mean "auto-detect", and a strict
// `??` here previously left API_BASE='' which made every fetch resolve
// against the current page (`/auth/session` instead of `/api/auth/session`)
// and Caddy's SPA fallback served `index.html` to the data layer.
import { getScopeSlug } from './scope.ts';

export const API_BASE: string = resolveApiBase()

function resolveApiBase(): string {
  const env = import.meta.env.VITE_API_URL
  if (typeof env === 'string' && env.length > 0) return env
  if (import.meta.env.DEV) return 'http://localhost:3000'
  if (typeof window !== 'undefined') return `${window.location.origin}/api`
  return ''
}

const TOKEN_KEY = 'oxenfurt_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function fetchWithAuth(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  // The active scope rides every request; the backend falls back to the
  // default scope when the header is absent.
  const scope = getScopeSlug();
  if (scope) {
    headers.set('X-Scope', scope);
  }
  // Hono's c.req.json() requires the content-type header to start with
  // application/json. Set it whenever a body is being sent.
  if (options.body !== undefined && options.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401) {
    clearToken();
  }
  return response
}

export async function loginWithTelegram(initData: string): Promise<{ token: string; expires_in: number }> {
  const response = await fetch(`${API_BASE}/auth/session`, {
    method: 'POST',
    headers: { authorization: `tma ${initData}` },
  });
  if (!response.ok) {
    throw new Error(`auth_failed: ${response.status}`)
  }
  const data = (await response.json()) as { token: string; expires_in: number };
  setToken(data.token);
  return data;
}
