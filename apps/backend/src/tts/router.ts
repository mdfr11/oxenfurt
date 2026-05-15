import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.ts'

export interface TtsRouterDeps {
  jwtSecret: string
  now?: () => Date
}

/**
 * Server-side TTS proxy. The browser SpeechSynthesis API is unreliable on
 * Android because it depends on a system English voice that isn't installed
 * by default in many locales. Instead, we proxy Google Translate's
 * unofficial-but-widely-used TTS endpoint and return the resulting MP3 to
 * the client. Voice quality is consistent across iOS / Android / desktop.
 *
 * The upstream is unauthenticated but rate-limited per IP. For single-user
 * traffic (~100 plays/day) the limit is irrelevant; if it ever bites, we
 * can add filesystem caching or move to a paid TTS provider.
 *
 * The endpoint requires JWT auth (no anonymous access), and uses a 30-day
 * Cache-Control so the browser keeps the audio for repeat plays of the
 * same term.
 */
export function createTtsRouter(deps: TtsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  app.get('/', async (c) => {
    const text = (c.req.query('text') ?? '').trim()
    if (text.length === 0 || text.length > 200) {
      return c.json({ error: 'invalid_text' }, 400)
    }
    const lang = (c.req.query('lang') ?? 'en').slice(0, 8)

    const params = new URLSearchParams({
      ie: 'UTF-8',
      tl: lang,
      q: text,
      client: 'tw-ob',
    })
    const upstream = `https://translate.google.com/translate_tts?${params.toString()}`

    let res: Response
    try {
      res = await fetch(upstream, {
        headers: {
          // Google blocks requests with default Node UA. Anything browsery works.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          'Referer': 'https://translate.google.com/',
        },
      })
    } catch (err) {
      console.error('[tts] upstream fetch failed', err)
      return c.json({ error: 'upstream_unreachable' }, 502)
    }

    if (!res.ok || res.body === null) {
      console.warn('[tts] upstream returned', res.status, 'for', text)
      return c.json({ error: 'upstream_failed', status: res.status }, 502)
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=2592000, immutable',
      },
    })
  })

  return app
}
