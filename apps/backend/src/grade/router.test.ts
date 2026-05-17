import { describe, expect, test } from 'bun:test'
import { signSession } from '../auth/jwt.ts'
import type { ChatMessage, ChatOptions, LlmClient } from '../llm/client.ts'
import { createGradeRouter } from './router.ts'

const JWT_SECRET = '0123456789abcdef0123456789abcdef-grade'
const NOW = new Date('2026-05-17T12:00:00.000Z')

async function authHeader(): Promise<string> {
  const token = await signSession({ userId: 1 }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return `Bearer ${token}`
}

function stubLlm(
  reply: string | (() => Promise<string>),
): LlmClient & { calls: Array<{ messages: ChatMessage[]; opts: ChatOptions | undefined }> } {
  const calls: Array<{ messages: ChatMessage[]; opts: ChatOptions | undefined }> = []
  return {
    calls,
    async chat(messages, opts) {
      calls.push({ messages, opts })
      return typeof reply === 'function' ? await reply() : reply
    },
  }
}

function buildApp(llm: LlmClient | null) {
  return createGradeRouter({ jwtSecret: JWT_SECRET, llm, now: () => NOW })
}

const validBody = JSON.stringify({ user_answer: 'versatile', expected: 'versatile' })

describe('POST /grade', () => {
  test('401 without bearer', async () => {
    const res = await buildApp(stubLlm('{}')).request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(401)
  })

  test('503 llm_not_configured when LLM is disabled', async () => {
    const res = await buildApp(null).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'llm_not_configured' })
  })

  test('400 invalid_body on non-JSON input', async () => {
    const res = await buildApp(stubLlm('{}')).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_body' })
  })

  test('400 invalid_payload on missing fields', async () => {
    const res = await buildApp(stubLlm('{}')).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ user_answer: 'x' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' })
  })

  test('502 llm_failed when chat throws', async () => {
    const llm = stubLlm(async () => {
      throw new Error('upstream blew up')
    })
    const res = await buildApp(llm).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'llm_failed' })
  })

  test('502 llm_bad_format when model returns non-JSON', async () => {
    const res = await buildApp(stubLlm('I think the answer is correct.')).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'llm_bad_format' })
  })

  test('502 llm_bad_format when verdict field is missing/invalid', async () => {
    const res = await buildApp(
      stubLlm(JSON.stringify({ verdict: 'maybe', reason: 'eh' })),
    ).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(502)
  })

  test('200 with verdict on well-formed JSON', async () => {
    const res = await buildApp(
      stubLlm(JSON.stringify({ verdict: 'correct', reason: 'identical' })),
    ).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ verdict: 'correct', reason: 'identical' })
  })

  test('200 with verdict when model wraps JSON in ```json fences', async () => {
    const fenced = '```json\n{"verdict":"close","reason":"синоним"}\n```'
    const res = await buildApp(stubLlm(fenced)).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: validBody,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ verdict: 'close', reason: 'синоним' })
  })

  test('passes jsonMode + temperature 0 to the LLM', async () => {
    const llm = stubLlm(JSON.stringify({ verdict: 'wrong', reason: 'no' }))
    await buildApp(llm).request('/', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: validBody,
    })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]!.opts?.jsonMode).toBe(true)
    expect(llm.calls[0]!.opts?.temperature).toBe(0)
  })
})
