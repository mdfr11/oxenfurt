import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { ScopeRef } from './scope.ts'

export interface IngestScopeAuthOptions {
  /** token → scope. One entry per configured agent token. */
  tokens: ReadonlyMap<string, ScopeRef>
}

/**
 * Bearer-token auth for agent surfaces. The token IS the scope: each
 * Hermes profile carries its own token, and the middleware resolves
 * which scope the request acts inside before any handler runs. An agent
 * can therefore never write into another scope, even if a prompt
 * injection asks it to — the backend simply has no route for that.
 */
export function ingestScopeAuth(opts: IngestScopeAuthOptions): MiddlewareHandler {
  // Pre-buffers for a length-independent timing-safe comparison loop.
  const candidates = [...opts.tokens.entries()].map(([token, scope]) => ({
    expected: Buffer.from(token),
    scope,
  }))
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const provided = Buffer.from(match[1]!)
    for (const { expected, scope } of candidates) {
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        c.set('scope', scope)
        await next()
        return undefined
      }
    }
    return c.json({ error: 'unauthorized' }, 401)
  }
}
