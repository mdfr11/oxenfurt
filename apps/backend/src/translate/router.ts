// In-card tap-to-translate. Two providers in priority order:
//   1. The configured LLM (context-aware, high quality)
//   2. MyMemory translation memory (no context, community-sourced —
//      and prone to surfacing niche senses first, see the "cake → жмых"
//      regression report)
// LLM is preferred whenever it's configured and the request includes a
// surrounding sentence. MyMemory is the fallback so the feature still
// works when LLM env isn't set.

import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.ts'
import type { LlmClient } from '../llm/client.ts'

export interface TranslateRouterDeps {
  jwtSecret: string
  /** Optional LLM client. Falsy → endpoint always uses MyMemory. */
  llm?: LlmClient | null
  now?: () => Date
}

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
}

function langName(code: string): string {
  // Strip region suffix (en-US → en) for the dictionary lookup; fall
  // back to the raw code if we don't know the language name.
  const bare = code.split('-')[0]!.toLowerCase()
  return LANG_NAMES[bare] ?? code
}

export function createTranslateRouter(deps: TranslateRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  app.get('/', async (c) => {
    const text = c.req.query('text')
    if (!text) return c.json({ error: 'missing_text' }, 400)
    if (text.length > 500) return c.json({ error: 'text_too_long' }, 400)

    // Langpair source / target — defaults to en→ru. Restricted to
    // two-letter ISO codes (optionally with a region suffix) so a
    // malformed value can't be used to forge an upstream URL or smuggle
    // anything into the LLM prompt.
    const fromRaw = c.req.query('from') ?? 'en'
    const toRaw = c.req.query('to') ?? 'ru'
    if (!isValidLangCode(fromRaw) || !isValidLangCode(toRaw)) {
      return c.json({ error: 'invalid_lang' }, 400)
    }

    // Optional surrounding sentence. Lets the LLM disambiguate
    // multi-sense words ("like" the verb vs "like" the preposition).
    // Bounded so a misbehaving client can't blow up the prompt.
    const contextRaw = c.req.query('context')
    const context = typeof contextRaw === 'string' && contextRaw.length > 0
      ? contextRaw.slice(0, 500)
      : null

    // 1. LLM path — best quality when configured and context is helpful.
    if (deps.llm) {
      const translations = await translateViaLlm(deps.llm, text, fromRaw, toRaw, context)
      if (translations !== null && translations.length > 0) {
        return c.json({ translations })
      }
      // LLM returned nothing usable — fall through to MyMemory.
    }

    // 2. MyMemory fallback.
    const result = await translateViaMyMemory(text, fromRaw, toRaw)
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json({ translations: result.translations })
  })

  return app
}

type TranslateResult =
  | { translations: string[] }
  | { error: 'service_unreachable' | 'no_translation'; status: 502 }

/**
 * Ask the configured LLM for up to 3 short context-aware translations.
 * Returns null on any failure so the caller can fall back to MyMemory.
 * Cheap because we cap output at ~30 tokens — typical answer is one or
 * two short words separated by " · ".
 */
async function translateViaLlm(
  llm: LlmClient,
  text: string,
  from: string,
  to: string,
  context: string | null,
): Promise<string[] | null> {
  const system = [
    `You translate single words and short phrases between languages.`,
    `Output ONLY the translation(s) — 1-3 short alternatives separated by ' · '.`,
    `No explanations, no source word, no quotes, no trailing punctuation.`,
    `If a context sentence is provided, prefer the sense that fits the context first.`,
  ].join(' ')

  const userParts: string[] = [
    `Translate "${text}" from ${langName(from)} to ${langName(to)}.`,
  ]
  if (context !== null) {
    userParts.push(`Context: "${context}"`)
  }

  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userParts.join('\n') },
      ],
      { temperature: 0, maxTokens: 80, timeoutMs: 8000 },
    )
    const parsed = parseTranslations(raw)
    if (parsed.length === 0) return null
    return parsed
  } catch (err) {
    console.warn('[translate] llm failed, falling back', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Best-effort parse of the LLM's free-form response. Trims, strips
 * quotes / fence markers, splits on " · " primarily, with commas and
 * line breaks as secondary separators (models sometimes use those even
 * when told not to). Caps at 3 entries.
 */
function parseTranslations(raw: string): string[] {
  let cleaned = raw.trim()
  // Strip markdown fences if the model wrapped its answer.
  cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  // Strip leading/trailing quotes around the whole answer.
  cleaned = cleaned.replace(/^["“'`]+|["”'`]+$/g, '').trim()
  if (cleaned.length === 0) return []

  const parts = cleaned
    .split(/\s*·\s*|\s*[,\n]\s*/)
    .map((p) => p.trim().replace(/^["“'`]+|["”'`.,;]+$/g, '').trim())
    .filter((p) => p.length > 0 && p.length < 100)
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= 3) break
  }
  return out
}

/**
 * MyMemory fallback. Same ranking logic as before — kept around so the
 * feature still works for forkers who haven't configured an LLM. The
 * "cake → жмых" pathology still applies here; we mitigate by showing
 * the top 3 high-quality matches instead of MyMemory's raw first hit.
 */
async function translateViaMyMemory(
  text: string,
  from: string,
  to: string,
): Promise<TranslateResult> {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.warn('[translate] upstream', res.status)
      return { error: 'service_unreachable', status: 502 }
    }
    const data = (await res.json()) as {
      responseData?: { translatedText?: string }
      matches?: Array<{ translation?: string; quality?: string; 'usage-count'?: number; match?: number }>
    }
    const matches = data.matches ?? []
    const ranked = matches
      .filter((m) => typeof m.translation === 'string' && m.translation.length > 0)
      .filter((m) => Number.parseInt(m.quality ?? '0', 10) >= 60)
      .sort((a, b) => {
        const am = a.match ?? 0
        const bm = b.match ?? 0
        if (bm !== am) return bm - am
        const aq = Number.parseInt(a.quality ?? '0', 10)
        const bq = Number.parseInt(b.quality ?? '0', 10)
        if (bq !== aq) return bq - aq
        return (b['usage-count'] ?? 0) - (a['usage-count'] ?? 0)
      })
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
    if (translations.length === 0) {
      const top = data.responseData?.translatedText ?? ''
      if (top.length === 0) return { error: 'no_translation', status: 502 }
      translations.push(top)
    }
    return { translations }
  } catch (err) {
    console.error('[translate] fetch failed', err)
    return { error: 'service_unreachable', status: 502 }
  }
}

const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/
function isValidLangCode(s: string): boolean {
  return LANG_RE.test(s)
}
