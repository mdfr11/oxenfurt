import type { MiddlewareHandler } from 'hono'
import { verifySession, type SessionClaims } from '../auth/jwt.ts'

declare module 'hono' {
  interface ContextVariableMap {
    session: SessionClaims
  }
}

export interface JwtAuthOptions {
  jwtSecret: string
  now?: () => Date
}

export function jwtAuth(opts: JwtAuthOptions): MiddlewareHandler {
  const now = opts.now ?? (() => new Date())
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const claims = await verifySession(match[1]!, opts.jwtSecret, { now: now() })
    if (claims === null) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    c.set('session', claims)
    await next()
    return undefined
  }
}
