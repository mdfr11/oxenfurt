import { describe, expect, test } from 'bun:test'
import { signSession, verifySession } from './jwt.ts'

const SECRET = '0123456789abcdef0123456789abcdef-test-only'
const OTHER_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-other'
const NOW_MS = Date.parse('2026-01-01T12:00:00.000Z')

describe('signSession / verifySession', () => {
  test('sign → verify round-trip preserves userId', async () => {
    const token = await signSession({ userId: 12345 }, SECRET, {
      ttlSeconds: 900,
      now: new Date(NOW_MS),
    })
    const claims = await verifySession(token, SECRET, { now: new Date(NOW_MS) })
    expect(claims).not.toBeNull()
    expect(claims?.userId).toBe(12345)
  })

  test('signed token can be parsed once until it expires', async () => {
    const token = await signSession({ userId: 1 }, SECRET, {
      ttlSeconds: 60,
      now: new Date(NOW_MS),
    })
    const stillValid = await verifySession(token, SECRET, {
      now: new Date(NOW_MS + 59_000),
    })
    expect(stillValid).not.toBeNull()
  })

  test('returns null for a token verified with a different secret', async () => {
    const token = await signSession({ userId: 1 }, SECRET, {
      ttlSeconds: 900,
      now: new Date(NOW_MS),
    })
    const claims = await verifySession(token, OTHER_SECRET, { now: new Date(NOW_MS) })
    expect(claims).toBeNull()
  })

  test('returns null for an expired token', async () => {
    const token = await signSession({ userId: 1 }, SECRET, {
      ttlSeconds: 60,
      now: new Date(NOW_MS),
    })
    const claims = await verifySession(token, SECRET, {
      now: new Date(NOW_MS + 120_000),
    })
    expect(claims).toBeNull()
  })

  test('returns null for a malformed token', async () => {
    const claims = await verifySession('not.a.jwt', SECRET, { now: new Date(NOW_MS) })
    expect(claims).toBeNull()
  })

  test('returns null when the userId claim is missing or wrong type', async () => {
    const token = await signSession(
      { userId: 'not-a-number' } as unknown as { userId: number },
      SECRET,
      { ttlSeconds: 900, now: new Date(NOW_MS) },
    )
    const claims = await verifySession(token, SECRET, { now: new Date(NOW_MS) })
    expect(claims).toBeNull()
  })

  test('returns null when audience does not match', async () => {
    // Forge a token signed with the same secret but a different audience —
    // simulates someone reusing the JWT_SECRET for a different service.
    const { SignJWT } = await import('jose')
    const issuedAt = Math.floor(NOW_MS / 1000)
    const token = await new SignJWT({ userId: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('oxenfurt')
      .setAudience('some-other-app')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 900)
      .sign(new TextEncoder().encode(SECRET))
    const claims = await verifySession(token, SECRET, { now: new Date(NOW_MS) })
    expect(claims).toBeNull()
  })
})
