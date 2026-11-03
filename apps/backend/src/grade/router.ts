import { Hono } from 'hono'
import * as v from 'valibot'
import type { LlmClient } from '../llm/client.ts'
import { jwtAuth } from '../middleware/auth.ts'

export interface GradeRouterDeps {
  jwtSecret: string
  /** Null when LLM env isn't configured — endpoint returns 503. */
  llm: LlmClient | null
  now?: () => Date
}

// Two grading jobs share this endpoint:
//   * 'term' (default) — did the learner produce the expected word or
//     phrase? Character-similarity is meaningless for paraphrase, so
//     the LLM judges semantic equivalence of short answers.
//   * 'explanation' — did the learner's free-form answer to a study
//     question carry the same understanding as the reference? Used by
//     typed-theory practice: the learner types an explanation from
//     memory and the model grades conceptual coverage, not text.
const GradeInputSchema = v.object({
  kind: v.optional(v.picklist(['term', 'explanation'] as const), 'term'),
  user_answer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  expected: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  // Optional context for the prompt. For 'term' — the learning-language
  // meaning; for 'explanation' — the question the learner was answering.
  hint: v.optional(v.pipe(v.string(), v.maxLength(500))),
})

interface GradeVerdict {
  verdict: 'correct' | 'close' | 'wrong'
  reason: string
}

const PROMPT_SYSTEM_TERM = `You grade a single English answer from a language learner.
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

const PROMPT_SYSTEM_EXPLANATION = `You grade a learner's free-form answer to a study question (any subject: language, programming, medicine, …).
The learner saw the question and typed their answer from memory. A reference answer is provided.
Decide whether the typed answer conveys the same understanding as the reference.

Return STRICT JSON only — no prose around it — matching this shape:
{ "verdict": "correct" | "close" | "wrong", "reason": "<one short Russian sentence>" }

Rules:
- "correct" — covers the key points of the reference in the learner's own words. Wording, language, order and omission of minor details do not matter.
- "close" — the core idea is present, but an important part is missing or partially wrong.
- "wrong" — misses the point of the question, is factually wrong, or merely restates the question.
- Judge understanding, not text similarity. A shorter answer than the reference can still be "correct".
- The reason MUST be a single short sentence in Russian (≤120 chars).
- Never explain your own reasoning. Output JSON, nothing else.`

export function createGradeRouter(deps: GradeRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  app.post('/', async (c) => {
    if (deps.llm === null) {
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
    const { kind, user_answer, expected, hint } = parsed.output

    const systemPrompt = kind === 'explanation' ? PROMPT_SYSTEM_EXPLANATION : PROMPT_SYSTEM_TERM
    const userPrompt =
      kind === 'explanation'
        ? [
            `Question:          "${hint ?? ''}"`,
            `Reference answer:  "${expected}"`,
            `Learner's answer:  "${user_answer}"`,
          ].join('\n')
        : [
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
          { role: 'system', content: systemPrompt },
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
