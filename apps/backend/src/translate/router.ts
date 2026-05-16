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

    // Using MyMemory free API for translation (no key required for small traffic)
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ru`
    
    try {
      const res = await fetch(url)
      const data = (await res.json()) as { responseData?: { translatedText?: string } }
      const translation = data.responseData?.translatedText ?? 'Translation failed'

      return c.json({ translation })
    } catch (err) {
      console.error('[translate] fetch failed', err)
      return c.json({ error: 'service_unreachable' }, 502)
    }
  })

  return app
}
