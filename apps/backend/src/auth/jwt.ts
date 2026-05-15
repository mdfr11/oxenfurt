import { SignJWT, jwtVerify } from 'jose'

export interface SessionClaims {
  userId: number
}

export interface SignSessionOptions {
  ttlSeconds: number
  now?: Date
}

export interface VerifySessionOptions {
  now?: Date
}

const ISSUER = 'oxenfurt'
const AUDIENCE = 'oxenfurt-mini-app'

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signSession(
  claims: SessionClaims,
  secret: string,
  opts: SignSessionOptions,
): Promise<string> {
  const issuedAt = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  return await new SignJWT({ userId: claims.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + opts.ttlSeconds)
    .sign(secretKey(secret))
}

export async function verifySession(
  token: string,
  secret: string,
  opts: VerifySessionOptions = {},
): Promise<SessionClaims | null> {
  const currentDate = opts.now ?? new Date()
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate,
    })
    const userId = payload.userId
    if (typeof userId !== 'number' || !Number.isInteger(userId)) {
      return null
    }
    return { userId }
  } catch {
    // Any verification failure — bad signature, expired, malformed, wrong
    // issuer/audience — maps to "not authenticated". Callers don't need to
    // distinguish further; the security model is the same either way.
    return null
  }
}
