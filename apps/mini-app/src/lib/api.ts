// Empty string is a valid prod value (same-origin via reverse proxy).
// Only fall back to the dev backend when the env var is *missing*.
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

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
