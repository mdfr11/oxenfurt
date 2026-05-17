import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { notifyHermes } from './router.ts'

// fetch is stubbed per-test; restore the global between tests so a hung
// test can't poison the next one.
const realFetch = globalThis.fetch

interface CapturedRequest {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: string
}

let captured: CapturedRequest[] = []
function captureFetch(response: Response | (() => Promise<Response>)): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    const hdrInit = init?.headers
    if (hdrInit !== undefined) {
      for (const [k, v] of new Headers(hdrInit).entries()) {
        headers[k.toLowerCase()] = v
      }
    }
    captured.push({
      url,
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    })
    return typeof response === 'function' ? await response() : response
  }) as typeof fetch
}

beforeEach(() => {
  captured = []
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('notifyHermes', () => {
  test('signs the body with HMAC-SHA256 using the configured secret', async () => {
    captureFetch(new Response(null, { status: 200 }))
    const secret = 'super-long-shared-secret-please-rotate-me'
    await notifyHermes(
      { url: 'http://127.0.0.1:8644/webhooks/oxenfurt-questions', secret },
      { question_id: 'q-1', card_id: 'c-1', question: 'what does versatile mean?' },
    )

    expect(captured).toHaveLength(1)
    const sent = captured[0]!
    expect(sent.url).toBe('http://127.0.0.1:8644/webhooks/oxenfurt-questions')
    expect(sent.method).toBe('POST')
    expect(sent.headers['content-type']).toBe('application/json')

    const expectedBody = JSON.stringify({
      event_type: 'question_created',
      payload: { question_id: 'q-1', card_id: 'c-1', question: 'what does versatile mean?' },
    })
    expect(sent.body).toBe(expectedBody)

    const expectedSig = createHmac('sha256', secret).update(expectedBody).digest('hex')
    expect(sent.headers['x-webhook-signature']).toBe(expectedSig)
  })

  test('different secrets produce different signatures over the same body', async () => {
    captureFetch(new Response(null, { status: 200 }))
    await notifyHermes(
      { url: 'http://example.test/h', secret: 'secret-a-padded-to-32-chars-min!!' },
      { question_id: 'q', card_id: 'c', question: 'x' },
    )
    await notifyHermes(
      { url: 'http://example.test/h', secret: 'secret-b-padded-to-32-chars-min!!' },
      { question_id: 'q', card_id: 'c', question: 'x' },
    )
    expect(captured).toHaveLength(2)
    expect(captured[0]!.headers['x-webhook-signature']).not.toBe(
      captured[1]!.headers['x-webhook-signature'],
    )
  })

  test('swallows fetch failures (fire-and-forget — must not throw)', async () => {
    captureFetch(() => Promise.reject(new Error('network down')))
    // Should NOT throw — the user-facing POST /questions/cards/:id must
    // succeed even if the webhook target is gone.
    await expect(
      notifyHermes(
        { url: 'http://127.0.0.1:1/never', secret: 'whatever-secret-32-chars-min!!!' },
        { question_id: 'q', card_id: 'c', question: 'x' },
      ),
    ).resolves.toBeUndefined()
  })

  test('swallows non-2xx responses without throwing', async () => {
    captureFetch(new Response('boom', { status: 500 }))
    await expect(
      notifyHermes(
        { url: 'http://h.test', secret: 'whatever-secret-32-chars-min!!!' },
        { question_id: 'q', card_id: 'c', question: 'x' },
      ),
    ).resolves.toBeUndefined()
  })
})
