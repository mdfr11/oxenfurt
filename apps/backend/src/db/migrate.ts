import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createDb } from './client.ts'

const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
)

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 })
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await close()
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }
  await runMigrations(url)
  // eslint-disable-next-line no-console
  console.log('migrations applied')
}
