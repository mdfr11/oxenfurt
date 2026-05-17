import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { signSession } from '../auth/jwt.ts'
import { createTranslateRouter } from './router.ts'

const JWT_SECRET = '0123456789abcdef0123456789abcdef-trans'
const NOW = new Date('2026-05-17T12:00:00.000Z')

async function authHeader(): Promise<string> {
  const token = await signSession({ userId: 1 }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return `Bearer ${token}`
}

const realFetch = globalThis.fetch
let upstreamCalls: string[] = []

function stubFetch(response: Response | (() => Promise<Response>)): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    upstreamCalls.push(typeof input === 'string' ? input : input.toString())
    return typeof response === 'function' ? await response() : response
  }) as typeof fetch
}

beforeEach(() => {
  upstreamCalls = []
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function app() {
  return createTranslateRouter({ jwtSecret: JWT_SECRET, now: () => NOW })
}

describe('GET /translate', () => {
  test('401 without bearer', async () => {
    const res = await app().request('/?text=hello')
    expect(res.status).toBe(401)
  })

  test('400 missing_text when ?text is absent', async () => {
    const res = await app().request('/', { headers: { authorization: await authHeader() } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_text' })
  })

  test('400 text_too_long when text > 500 chars', async () => {
    const big = 'x'.repeat(501)
    const res = await app().request(`/?text=${encodeURIComponent(big)}`, {
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'text_too_long' })
  })

  test('rejects malformed ?from / ?to with invalid_lang', async () => {
    const auth = await authHeader()
    const bad = ['EN', 'english', 'en_US', 'en|ru', 'javascript:alert(1)', '../etc', '']
    for (const v of bad) {
      const res = await app().request(`/?text=hi&from=${encodeURIComponent(v)}`, {
        headers: { authorization: auth },
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_lang' })
    }
  })

  test('accepts well-formed lang codes (en, en-US, ru)', async () => {
    stubFetch(
      new Response(JSON.stringify({ responseData: { translatedText: 'привет' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await app().request('/?text=hello&from=en&to=ru', {
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ translation: 'привет' })
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]).toContain('langpair=en|ru')
  })

  test('default langpair is en|ru when ?from/?to omitted', async () => {
    stubFetch(
      new Response(JSON.stringify({ responseData: { translatedText: 'кот' } }), { status: 200 }),
    )
    await app().request('/?text=cat', { headers: { authorization: await authHeader() } })
    expect(upstreamCalls[0]).toContain('langpair=en|ru')
  })

  test('502 service_unreachable when upstream returns non-2xx', async () => {
    stubFetch(new Response('boom', { status: 503 }))
    const res = await app().request('/?text=hello', {
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'service_unreachable' })
  })

  test('502 service_unreachable when fetch throws', async () => {
    stubFetch(() => Promise.reject(new Error('network down')))
    const res = await app().request('/?text=hello', {
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(502)
  })

  test('502 no_translation when upstream returns empty translation', async () => {
    stubFetch(
      new Response(JSON.stringify({ responseData: { translatedText: '' } }), { status: 200 }),
    )
    const res = await app().request('/?text=hello', {
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'no_translation' })
  })

  test('URL-encodes the user-supplied text into ?q=', async () => {
    stubFetch(
      new Response(JSON.stringify({ responseData: { translatedText: 'x' } }), { status: 200 }),
    )
    await app().request('/?text=' + encodeURIComponent('hello & goodbye'), {
      headers: { authorization: await authHeader() },
    })
    expect(upstreamCalls[0]).toContain('q=hello%20%26%20goodbye')
  })
})
