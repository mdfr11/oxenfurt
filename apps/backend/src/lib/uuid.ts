// Same regex three router files used to declare inline. UUID v1-v5
// formats all match — we don't care about version bits, we just want a
// fast rejection of obviously-not-an-id path params before hitting the
// database. Postgres' uuid type would reject these too, but the error
// path is uglier (PostgresError instead of a clean 400).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
