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
      const data = (await res.json()) as {
        responseData?: { translatedText?: string }
        matches?: Array<{ translation?: string; quality?: string; 'usage-count'?: number; match?: number }>
      }
      // Pick the top few high-quality matches instead of the single
      // first one. MyMemory's translation memory is community-sourced;
      // tapping on "cake" was returning "жмых" because that entry
      // happened to be most recent. Showing the top 2-3 candidates
      // gives the learner the obvious sense AND the niche ones so
      // they can pick the right meaning for the context.
      const matches = data.matches ?? []
      const ranked = matches
        .filter((m) => typeof m.translation === 'string' && m.translation.length > 0)
        .filter((m) => Number.parseInt(m.quality ?? '0', 10) >= 60)
        // Prefer high-confidence exact segment matches, then by usage.
        .sort((a, b) => {
          const am = a.match ?? 0
          const bm = b.match ?? 0
          if (bm !== am) return bm - am
          const aq = Number.parseInt(a.quality ?? '0', 10)
          const bq = Number.parseInt(b.quality ?? '0', 10)
          if (bq !== aq) return bq - aq
          return (b['usage-count'] ?? 0) - (a['usage-count'] ?? 0)
        })
      // Dedupe by translation text (case-insensitive) preserving order,
      // and cap at 3 — beyond that the tooltip becomes noisy.
      const seen = new Set<string>()
      const translations: string[] = []
      for (const m of ranked) {
        const t = m.translation!.trim()
        const key = t.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        translations.push(t)
        if (translations.length >= 3) break
      }
      // Fall back to responseData.translatedText if filtering wiped
      // everything out (rare; covers requests where matches is empty
      // but the top-level field still has a machine translation).
      if (translations.length === 0) {
        const top = data.responseData?.translatedText ?? ''
        if (top.length === 0) return c.json({ error: 'no_translation' }, 502)
        translations.push(top)
      }
      return c.json({ translations })
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
