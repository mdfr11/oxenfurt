import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import * as schema from './schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

export interface DbConnection {
  db: Db
  sql: Sql
  close: () => Promise<void>
}

export function createDb(url: string, opts: { max?: number } = {}): DbConnection {
  const sql = postgres(url, { max: opts.max ?? 10 })
  const db = drizzle(sql, { schema })
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 })
    },
  }
}
