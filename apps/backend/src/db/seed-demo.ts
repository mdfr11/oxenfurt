// Demo seed for fresh installs. Inserts ~30 example cards so a forker
// who just ran install.sh opens the Mini App and sees something to do —
// otherwise the first impression is a coffee-cup empty state.
//
// Cards are real English vocabulary with English-language definitions in
// the `translation` field (instead of translating to the operator's
// native language, since we can't know what that is at install time).
// FSRS state is varied — some brand new, some mid-learning, some mature —
// so the dashboard, heatmap, and "due now" metric all show non-trivial
// numbers immediately.
//
// Idempotent: each card carries `source='demo'`. The seed checks if any
// card with that source already exists and bails out if so.
//
// Usage:
//   DATABASE_URL=postgres://... bun apps/backend/src/db/seed-demo.ts
//
// install.sh --with-demo runs this at the end of the deploy pipeline.

import { sql } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { createDb } from './client.ts'
import { scopeBySlug } from './scopes.ts'

interface SeedCard {
  type: 'vocab' | 'phrase' | 'theory'
  payload: Record<string, unknown>
  source: string
  source_quote?: string
  /** Days ago this card was "first learned". Drives synthetic FSRS state. */
  agedDays: number
  /** Number of synthetic reviews already applied. */
  reps: number
}

const NOW = new Date()
const DAY_MS = 24 * 60 * 60 * 1000

// 30 cards across 3 lessons. Mix of vocab (20) + phrase (7) + theory (3).
// Aging is rigged so the heatmap has activity across the last 14 days
// and ~6 cards are due now.
const SEED: SeedCard[] = [
  // --- Lesson 1 — mature, mostly learned ---
  v('pragmatic', 'dealing with things sensibly and realistically rather than theoretically', 'She is known for her pragmatic approach to problem-solving.', 1, 12, 8),
  v('versatile', 'able to adapt to many different functions or activities', 'A versatile musician can play several instruments well.', 1, 14, 9),
  v('sturdy', 'strongly and solidly built; resilient', 'The old oak table is sturdy enough to last another century.', 1, 11, 7),
  v('contemplative', 'expressing or involving prolonged thought', 'He looked contemplative as he stared out the window.', 1, 9, 6),
  v('intricate', 'very complicated or detailed', 'The watch has an intricate mechanism with hundreds of parts.', 1, 13, 8),
  p('on the other hand', 'introduces a contrasting point of view',
    "It's expensive, but on the other hand it lasts forever.", 1, 10, 7),
  p('by no means', 'absolutely not; emphatic negative',
    'This is by no means the final draft — expect changes.', 1, 12, 8),
  t('When to use *make* vs *do*',
    "**make** is for *creating / producing* (`make coffee`, `make a decision`).\n\n**do** is for *performing / executing* (`do homework`, `do the dishes`).\n\nFixed collocations just have to be memorised — there's no rule.",
    'A common mix-up — drilling helps.', 1, 8, 6),

  // --- Lesson 2 — mid-learning, several due soon ---
  v('elaborate', 'involving many carefully arranged parts; or, to explain in more detail', 'Could you elaborate on that point?', 2, 5, 3),
  v('deliberate', 'done consciously and intentionally', 'It was a deliberate choice to keep the design minimal.', 2, 4, 3),
  v('inevitable', 'certain to happen; unavoidable', 'Some delays are inevitable on a project this large.', 2, 6, 4),
  v('subtle', 'so delicate or precise as to be difficult to analyse', "There's a subtle difference between the two flavours.", 2, 3, 2),
  v('vivid', 'producing powerful feelings or strong, clear images', 'She gave a vivid description of the festival.', 2, 5, 3),
  v('mundane', 'lacking interest or excitement; ordinary', 'After the trip, returning to mundane chores felt strange.', 2, 4, 3),
  v('reluctant', 'unwilling and hesitant', 'He was reluctant to admit he had been wrong.', 2, 6, 4),
  p('take into account', 'consider when making a decision',
    'You have to take the weather into account when planning the trip.', 2, 5, 3),
  p('look forward to', 'anticipate with pleasure',
    "I'm looking forward to seeing you next week.", 2, 4, 3),
  t('Past Simple vs Present Perfect',
    "**Past Simple** is for *finished actions at a specific time*: `I saw him yesterday`.\n\n**Present Perfect** is for *actions with present relevance, no specific time*: `I've seen him before`.\n\nIf you can ask `when?`, use Past Simple.",
    'A frequent source of confusion for Russian speakers.', 2, 7, 5),

  // --- Lesson 3 — fresh, mostly new cards (due now) ---
  v('serendipity', 'finding something good by chance', 'It was serendipity that we ended up sitting next to each other.', 3, 1, 0),
  v('ephemeral', 'lasting for a very short time', 'The beauty of cherry blossoms is famously ephemeral.', 3, 1, 0),
  v('ubiquitous', 'present, appearing, or found everywhere', 'Smartphones have become ubiquitous in modern life.', 3, 0, 0),
  v('quintessential', 'representing the most perfect example of a quality', 'A small cafe is the quintessential Parisian experience.', 3, 1, 0),
  v('meticulous', 'showing great attention to detail; very careful', 'She is meticulous about keeping her workspace tidy.', 3, 0, 0),
  v('candid', 'truthful and straightforward; frank', 'He gave a candid answer that surprised everyone.', 3, 2, 1),
  v('astute', 'having an ability to accurately assess situations', 'An astute investor noticed the trend early.', 3, 1, 0),
  p('cut to the chase', 'get to the point; skip preliminaries',
    "We don't have much time, so let me cut to the chase.", 3, 0, 0),
  p('beat around the bush', 'avoid saying something directly',
    "Stop beating around the bush and tell me what happened.", 3, 1, 0),
  p('once in a blue moon', 'very rarely',
    'We only see each other once in a blue moon these days.', 3, 0, 0),
  t('Articles: a / an / the — quick rules',
    "**a / an** — when the noun is *new* to the listener: `I saw a dog`.\n\n**the** — when the noun is *known* to both speakers: `the dog ran away`.\n\nProper nouns and most uncountables take no article: `Mary`, `water` (in general).\n\nMnemonic: `a/an` says *one of many*; `the` says *the specific one we both know*.",
    "The single biggest grammatical pain point for Slavic-language learners.", 3, 0, 0),
]

function v(term: string, definition: string, sentence: string, lesson: number, agedDays: number, reps: number): SeedCard {
  const start = sentence.toLowerCase().indexOf(term.toLowerCase())
  return {
    type: 'vocab',
    payload: {
      term,
      translation: definition,
      context_sentence: sentence,
      context_term_start: start >= 0 ? start : 0,
      context_term_end: start >= 0 ? start + term.length : term.length,
    },
    source: `demo-lesson-${lesson}`,
    source_quote: sentence,
    agedDays,
    reps,
  }
}

function p(phrase: string, definition: string, sentence: string, lesson: number, agedDays: number, reps: number): SeedCard {
  return {
    type: 'phrase',
    payload: {
      phrase,
      translation: definition,
      context_sentence: sentence,
    },
    source: `demo-lesson-${lesson}`,
    source_quote: sentence,
    agedDays,
    reps,
  }
}

function t(question: string, answer: string, hint: string, lesson: number, agedDays: number, reps: number): SeedCard {
  return {
    type: 'theory',
    payload: { question, answer },
    source: `demo-lesson-${lesson}`,
    source_quote: hint,
    agedDays,
    reps,
  }
}

export async function seedDemo(databaseUrl: string): Promise<{ inserted: number; skipped: boolean }> {
  const { db, close } = createDb(databaseUrl, { max: 1 })
  try {
    const existing = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*) AS count FROM cards WHERE source LIKE 'demo-lesson-%'
    `)
    if ((existing[0]?.count ?? '0') !== '0') {
      return { inserted: 0, skipped: true }
    }

    // Demo data belongs to the default scope (the first configured one,
    // 'english' on a stock install).
    const scope = await scopeBySlug(db, 'english')
    if (scope === undefined) {
      throw new Error('scope "english" not found — run migrations first')
    }

    const fsrs = new FsrsService({ enableFuzz: false })
    let inserted = 0

    for (const card of SEED) {
      // Walk the card through `reps` synthetic Good reviews aged
      // proportionally to agedDays. The exact values aren't important —
      // what matters is that the dashboard shows a realistic mix of
      // intervals and the heatmap has some squares lit up.
      let state = fsrs.createInitialState(new Date(NOW.getTime() - card.agedDays * DAY_MS))
      const stepDays = card.reps > 0 ? card.agedDays / card.reps : 0
      for (let i = 0; i < card.reps; i++) {
        const reviewedAt = new Date(NOW.getTime() - (card.agedDays - i * stepDays) * DAY_MS)
        const { next } = fsrs.applyRating(state, 3, reviewedAt) // 3 = Good
        state = next
      }

      const dueIso = new Date(state.due).toISOString()
      const lastReviewIso = state.last_review === null ? null : new Date(state.last_review).toISOString()
      await db.execute(sql`
        INSERT INTO cards (
          scope_id, type, status, payload, source, source_quote,
          fsrs_state, due, stability, difficulty,
          elapsed_days, scheduled_days, learning_steps,
          reps, lapses, last_review
        ) VALUES (
          ${scope.id}, ${card.type}, 'active', ${JSON.stringify(card.payload)}::jsonb,
          ${card.source}, ${card.source_quote ?? null},
          ${state.fsrs_state}, ${dueIso}, ${state.stability}, ${state.difficulty},
          ${state.elapsed_days}, ${state.scheduled_days}, ${state.learning_steps},
          ${state.reps}, ${state.lapses}, ${lastReviewIso}
        )
      `)
      inserted++
    }
    return { inserted, skipped: false }
  } finally {
    await close()
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }
  const { inserted, skipped } = await seedDemo(url)
  if (skipped) {
    console.log('Demo cards already present — skipping seed (delete them first to re-run).')
  } else {
    console.log(`Seeded ${inserted} demo cards across 3 lessons.`)
  }
}
