import type { MiddlewareHandler } from 'hono'
import type { ScopeRow } from '../db/schema.ts'
import { jwtAuth } from './auth.ts'
import { ingestScopeAuth } from './ingest-token.ts'

/** What every scoped handler reads from the context. */
export interface ScopeRef {
  slug: string
  id: string
}

declare module 'hono' {
  interface ContextVariableMap {
    scope: ScopeRef
  }
}

export function toScopeRef(row: ScopeRow): ScopeRef {
  return { slug: row.slug, id: row.id }
}

export function scopeRefMap(scopes: ScopeRow[]): ReadonlyMap<string, ScopeRef> {
  return new Map(scopes.map((row) => [row.slug, toScopeRef(row)]))
}

/**
 * Resolves the scope for user (Mini App) routes from the X-Scope
 * header. Absent header → the default scope (first configured), so
 * pre-scope clients keep working. Unknown slug → 400, not a silent
 * fallback: a typo'd scope must never quietly show another deck.
 *
 * Install AFTER jwtAuth — the header is trusted only for an
 * authenticated owner, which the single-user gate already is.
 */
export function resolveScope({ scopes }: { scopes: ScopeRow[] }): MiddlewareHandler {
  const bySlug = new Map(scopes.map((row) => [row.slug, toScopeRef(row)]))
  const fallback = toScopeRef(scopes[0]!)
  return async (c, next) => {
    const slug = c.req.header('x-scope')?.trim()
    if (slug === undefined || slug.length === 0) {
      c.set('scope', fallback)
    } else {
      const scope = bySlug.get(slug)
      if (scope === undefined) {
        return c.json({ error: 'unknown_scope' }, 400)
      }
      c.set('scope', scope)
    }
    await next()
    return undefined
  }
}

/**
 * Dual auth for routes both the Mini App and the agents hit (cards,
 * user assignments). A valid agent token resolves its scope directly;
 * anything else goes through JWT + X-Scope resolution.
 */
export function dualAuth(opts: {
  tokenScopes: ReadonlyMap<string, ScopeRef>
  jwtSecret: string
  scopes: ScopeRow[]
  now?: () => Date
}): MiddlewareHandler {
  const agentBranch = ingestScopeAuth({ tokens: opts.tokenScopes })
  const userBranch = jwtAuthWithScope(opts)
  return async (c, next) => {
    const auth = c.req.header('authorization') ?? ''
    const match = auth.match(/^bearer\s+(.+)$/i)
    if (match && opts.tokenScopes.has(match[1]!)) {
      return agentBranch(c, next)
    }
    return userBranch(c, next)
  }
}

/**
 * jwtAuth followed by scope resolution — the standard user stack.
 *
 * The two middlewares are sequenced, not nested: running the resolver
 * inside jwtAuth's `next` would discard its short-circuit Response
 * (jwtAuth swallows what next() returns), turning every `unknown_scope`
 * 400 into a 404. Here each Response that crosses a boundary is
 * returned across it.
 */
export function jwtAuthWithScope(opts: {
  jwtSecret: string
  scopes: ScopeRow[]
  now?: () => Date
}): MiddlewareHandler {
  const jwt = jwtAuth({
    jwtSecret: opts.jwtSecret,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  const resolver = resolveScope({ scopes: opts.scopes })
  return async (c, next) => {
    const res = await jwt(c, async () => {})
    if (res instanceof Response) return res
    return await resolver(c, next)
  }
}
