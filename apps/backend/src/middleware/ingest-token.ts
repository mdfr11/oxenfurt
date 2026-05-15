import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export interface IngestTokenAuthOptions {
  ingestToken: string
}

export function ingestTokenAuth(opts: IngestTokenAuthOptions): MiddlewareHandler {
  const expected = Buffer.from(opts.ingestToken)
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const provided = Buffer.from(match[1]!)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
    return undefined
  }
}
