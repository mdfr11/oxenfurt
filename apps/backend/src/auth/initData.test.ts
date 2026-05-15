import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { validateInitData } from './initData.ts'

const BOT_TOKEN = '1234567890:ABCDEF_test_bot_token_for_unit_tests'
const NOW_MS = Date.parse('2026-01-01T12:00:00.000Z')
const NOW_S = Math.floor(NOW_MS / 1000)
const NOW = new Date(NOW_MS)

function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields)
  const entries: Array<[string, string]> = []
  for (const [k, val] of params) {
    if (k !== 'hash') entries.push([k, val])
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const dataCheckString = entries.map(([k, val]) => `${k}=${val}`).join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

const VALID_USER_JSON = JSON.stringify({
  id: 12345,
  first_name: 'Daniil',
  username: 'hb',
  language_code: 'ru',
})

function freshFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(NOW_S),
    query_id: 'AAH_test_query_id',
    user: VALID_USER_JSON,
    ...overrides,
  }
}

describe('validateInitData', () => {
  test('accepts a freshly-signed payload and returns the parsed user', () => {
    const raw = signInitData(freshFields(), BOT_TOKEN)
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.user.id).toBe(12345)
      expect(result.user.first_name).toBe('Daniil')
      expect(result.user.username).toBe('hb')
      expect(result.authDate).toBe(NOW_S)
    }
  })

  test('rejects when the hash has been tampered with', () => {
    const raw = signInitData(freshFields(), BOT_TOKEN)
    const tampered = raw.replace(/hash=[a-f0-9]+/, `hash=${'0'.repeat(64)}`)
    const result = validateInitData(tampered, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_hash')
  })

  test('rejects when a signed field has been mutated after signing', () => {
    const raw = signInitData(freshFields(), BOT_TOKEN)
    // tweak query_id without re-signing
    const tampered = raw.replace('AAH_test_query_id', 'AAH_other_query_id')
    const result = validateInitData(tampered, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_hash')
  })

  test('rejects when signed with a different bot token', () => {
    const raw = signInitData(freshFields(), 'some-other-token:xxx')
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_hash')
  })

  test('rejects when auth_date is older than maxAgeSeconds', () => {
    const stale = NOW_S - 3601
    const raw = signInitData(freshFields({ auth_date: String(stale) }), BOT_TOKEN)
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale_auth_date')
  })

  test('accepts when auth_date is exactly at the maxAge boundary', () => {
    const raw = signInitData(freshFields({ auth_date: String(NOW_S - 3600) }), BOT_TOKEN)
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(true)
  })

  test('rejects when the hash field is missing', () => {
    const raw = new URLSearchParams(freshFields()).toString()
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_hash')
  })

  test('rejects when auth_date is missing', () => {
    const { auth_date: _drop, ...rest } = freshFields()
    void _drop
    const raw = signInitData(rest, BOT_TOKEN)
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_auth_date')
  })

  test('rejects when the user field is missing', () => {
    const { user: _drop, ...rest } = freshFields()
    void _drop
    const raw = signInitData(rest, BOT_TOKEN)
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_user')
  })

  test('rejects when user JSON is malformed even if the hash matches', () => {
    const raw = signInitData(freshFields({ user: 'not-json' }), BOT_TOKEN)
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed_user')
  })

  test('rejects when user JSON lacks the required id field', () => {
    const raw = signInitData(
      freshFields({ user: JSON.stringify({ first_name: 'X' }) }),
      BOT_TOKEN,
    )
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed_user')
  })

  test('rejects garbage that is not a valid query string structure', () => {
    const result = validateInitData('???not a querystring???', {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(false)
  })

  test('handles user JSON containing & = and other URL-special characters', () => {
    const fancyUser = JSON.stringify({
      id: 7,
      first_name: 'A&B',
      last_name: 'C=D',
      username: 'a+b c',
    })
    const raw = signInitData(freshFields({ user: fancyUser }), BOT_TOKEN)
    const result = validateInitData(raw, {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 3600,
      now: NOW,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.user.first_name).toBe('A&B')
      expect(result.user.last_name).toBe('C=D')
      expect(result.user.username).toBe('a+b c')
    }
  })
})
