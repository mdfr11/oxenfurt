import { Hono } from 'hono'
import * as v from 'valibot'
import type { LlmClient } from '../llm/client.ts'
import { jwtAuth } from '../middleware/auth.ts'

export interface GradeRouterDeps {
  jwtSecret: string
  llm: LlmClient
  now?: () => Date
}

const GradeInputSchema = v.object({
  user_answer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  expected: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  // Optional Russian translation / context for the prompt — helps the model
  // tell e.g. "leave" from "go away" by knowing which sense was expected.
  hint: v.optional(v.pipe(v.string(), v.maxLength(500))),
})

interface GradeVerdict {
  verdict: 'correct' | 'close' | 'wrong'
  reason: string
}

const PROMPT_SYSTEM = `You grade a single English answer from a language learner.
The learner was asked to produce a specific English word or phrase. They typed something.
Decide if the typed answer is semantically equivalent to the expected one.

Return STRICT JSON only — no prose around it — matching this shape:
{ "verdict": "correct" | "close" | "wrong", "reason": "<one short Russian sentence>" }

Rules:
- "correct" — exactly the expected meaning, allow minor spelling slips, capitalisation, articles.
- "close" — same intent, different but acceptable wording (e.g. synonyms, different register).
- "wrong" — different meaning, wrong word entirely, or empty.
- The reason MUST be a single short sentence in Russian (≤120 chars).
- Never explain your own reasoning. Output JSON, nothing else.`

export function createGradeRouter(deps: GradeRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  app.post('/', async (c) => {
    if (!deps.llm.available) {
      return c.json({ error: 'llm_not_configured' }, 503)
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(GradeInputSchema, body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', issues: parsed.issues }, 400)
    }
    const { user_answer, expected, hint } = parsed.output

    const userPrompt = [
      `Expected: "${expected}"`,
      `Typed:    "${user_answer}"`,
      hint !== undefined && hint.length > 0 ? `Hint (RU meaning): "${hint}"` : null,
    ]
      .filter((x): x is string => x !== null)
      .join('\n')

    let raw: string
    try {
      raw = await deps.llm.chat(
        [
          { role: 'system', content: PROMPT_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        {
          jsonMode: true,
          maxTokens: 200,
          temperature: 0,
          timeoutMs: 15_000,
        },
      )
    } catch (err) {
      console.error('[grade] LLM call failed', err)
      return c.json({ error: 'llm_failed' }, 502)
    }

    // Some providers return raw JSON, others wrap it in ```json fences.
    // Be liberal in what we accept.
    const json = extractJson(raw)
    if (json === null) {
      console.warn('[grade] LLM returned non-JSON output:', raw.slice(0, 200))
      return c.json({ error: 'llm_bad_format' }, 502)
    }
    const verdict = parseVerdict(json)
    if (verdict === null) {
      return c.json({ error: 'llm_bad_format' }, 502)
    }
    return c.json(verdict)
  })

  return app
}

function extractJson(s: string): unknown | null {
  const trimmed = s.trim()
  // Strip ```json ... ``` fences if present.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const candidate = fenceMatch ? fenceMatch[1]! : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function parseVerdict(value: unknown): GradeVerdict | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const v = obj.verdict
  const r = obj.reason
  if ((v !== 'correct' && v !== 'close' && v !== 'wrong') || typeof r !== 'string') {
    return null
  }
  return { verdict: v, reason: r }
}
