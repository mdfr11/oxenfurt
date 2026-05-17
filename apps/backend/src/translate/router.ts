import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.ts'

export interface TranslateRouterDeps {
  jwtSecret: string
  now?: () => Date
}

export function createTranslateRouter(deps: TranslateRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  app.get('/', async (c) => {
    const text = c.req.query('text')
    if (!text) return c.json({ error: 'missing_text' }, 400)
    if (text.length > 500) return c.json({ error: 'text_too_long' }, 400)

    // Langpair source / target — defaults to en→ru so the existing
    // hardcoded callers keep working. Polyglot frontend passes its own
    // pair via ?from= and ?to=. Restricted to two-letter ISO codes so
    // a malformed value can't be used to forge an upstream URL.
    const fromRaw = c.req.query('from') ?? 'en'
    const toRaw = c.req.query('to') ?? 'ru'
    if (!isValidLangCode(fromRaw) || !isValidLangCode(toRaw)) {
      return c.json({ error: 'invalid_lang' }, 400)
    }
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${fromRaw}|${toRaw}`

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) {
        console.warn('[translate] upstream', res.status)
        return c.json({ error: 'service_unreachable' }, 502)
      }
      const data = (await res.json()) as { responseData?: { translatedText?: string } }
      const translation = data.responseData?.translatedText ?? ''
      if (translation.length === 0) return c.json({ error: 'no_translation' }, 502)
      return c.json({ translation })
    } catch (err) {
      console.error('[translate] fetch failed', err)
      return c.json({ error: 'service_unreachable' }, 502)
    }
  })

  return app
}

const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/
function isValidLangCode(s: string): boolean {
  return LANG_RE.test(s)
}
