import { createHmac, timingSafeEqual } from 'node:crypto'
import * as v from 'valibot'

const TelegramUserSchema = v.object({
  id: v.pipe(v.number(), v.integer()),
  is_bot: v.optional(v.boolean()),
  first_name: v.optional(v.string()),
  last_name: v.optional(v.string()),
  username: v.optional(v.string()),
  language_code: v.optional(v.string()),
  is_premium: v.optional(v.boolean()),
  added_to_attachment_menu: v.optional(v.boolean()),
  allows_write_to_pm: v.optional(v.boolean()),
  photo_url: v.optional(v.string()),
})
export type TelegramUser = v.InferOutput<typeof TelegramUserSchema>

export type InitDataInvalidReason =
  | 'missing_hash'
  | 'missing_auth_date'
  | 'invalid_auth_date'
  | 'missing_user'
  | 'malformed_user'
  | 'invalid_hash'
  | 'stale_auth_date'

export type InitDataResult =
  | { ok: true; user: TelegramUser; authDate: number; raw: string }
  | { ok: false; reason: InitDataInvalidReason }

export interface ValidateInitDataOptions {
  botToken: string
  maxAgeSeconds: number
  now?: Date
}

/**
 * Validates a Telegram Mini App `initData` payload per the official spec:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Steps: parse querystring → strip `hash` → sort remaining fields alphabetically
 * → join as `key=value` lines with `\n` → HMAC-SHA256 with secret = HMAC(
 * "WebAppData", bot_token) → compare hex digest to `hash` via timing-safe
 * comparison.
 */
export function validateInitData(raw: string, opts: ValidateInitDataOptions): InitDataResult {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return { ok: false, reason: 'invalid_hash' }
  }

  const providedHash = params.get('hash')
  if (providedHash === null || providedHash.length === 0) {
    return { ok: false, reason: 'missing_hash' }
  }

  const authDateRaw = params.get('auth_date')
  if (authDateRaw === null) {
    return { ok: false, reason: 'missing_auth_date' }
  }
  const authDate = Number.parseInt(authDateRaw, 10)
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: 'invalid_auth_date' }
  }

  const userRaw = params.get('user')
  if (userRaw === null) {
    return { ok: false, reason: 'missing_user' }
  }

  const entries: Array<[string, string]> = []
  for (const [k, val] of params) {
    if (k !== 'hash') entries.push([k, val])
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const dataCheckString = entries.map(([k, val]) => `${k}=${val}`).join('\n')

  const secretKey = createHmac('sha256', 'WebAppData').update(opts.botToken).digest()
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  if (!constantTimeHexEqual(providedHash, computedHash)) {
    return { ok: false, reason: 'invalid_hash' }
  }

  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  if (nowSeconds - authDate > opts.maxAgeSeconds) {
    return { ok: false, reason: 'stale_auth_date' }
  }

  let userJson: unknown
  try {
    userJson = JSON.parse(userRaw)
  } catch {
    return { ok: false, reason: 'malformed_user' }
  }

  const parsedUser = v.safeParse(TelegramUserSchema, userJson)
  if (!parsedUser.success) {
    return { ok: false, reason: 'malformed_user' }
  }

  return { ok: true, user: parsedUser.output, authDate, raw }
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  // Buffer.from(str, 'hex') never throws — it returns an empty buffer
  // when the input is malformed. The length check below rejects that
  // case before timingSafeEqual sees mismatched lengths.
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length === 0 || bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
