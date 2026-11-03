import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { FsrsService, type DueCardDto } from '@oxenfurt/shared'
import { adoptLegacyPause, loadSession, saveSession, type PersistedSession } from './sessionPersist'

const storage = new Map<string, string>()
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  },
})

afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

beforeEach(() => storage.clear())

const fsrs = new FsrsService({ enableFuzz: false })
function card(id: string): DueCardDto {
  return {
    id,
    type: 'theory',
    payload: { question: id, answer: 'answer' },
    source: null,
    source_quote: null,
    fsrs: fsrs.createInitialState(new Date()),
  }
}

function session(ids: string[], currentIndex: number): PersistedSession {
  return {
    mode: 'recognition',
    scope: null,
    cards: ids.map(card),
    currentIndex,
    stats: { total: currentIndex, correct: 0 },
    savedAt: Date.now(),
  }
}

describe('loadSession with legacy replay cards', () => {
  test('removes already answered cards from the remaining queue without losing progress', () => {
    const saved = session(['a', 'b', 'a', 'c', 'b', 'd'], 2)
    saveSession(saved)

    const resumed = loadSession('recognition')!
    expect(resumed.cards.map(card => card.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(resumed.cards[resumed.currentIndex]!.id).toBe('c')
    expect(resumed.currentIndex).toBe(2)
    expect(resumed.stats).toEqual(saved.stats)
    expect(resumed.savedAt).toBe(saved.savedAt)
  })

  test('keeps only the first occurrence of each unanswered card, in order', () => {
    saveSession(session(['a', 'b', 'b', 'c', 'b', 'c'], 1))

    const resumed = loadSession()!
    expect(resumed.cards.map(card => card.id)).toEqual(['a', 'b', 'c'])
    expect(resumed.currentIndex).toBe(1)
  })

  test('preserves the reviewed history and statistics even when old repeats were already rated', () => {
    const saved = session(['a', 'b', 'a', 'c', 'a', 'd'], 3)
    saveSession(saved)

    const resumed = loadSession()!
    expect(resumed.cards.map(card => card.id)).toEqual(['a', 'b', 'a', 'c', 'd'])
    expect(resumed.currentIndex).toBe(3)
    expect(resumed.stats).toEqual(saved.stats)
  })

  test('clears a paused session when only repeats of answered cards remain', () => {
    saveSession(session(['a', 'b', 'a', 'b'], 2))

    expect(loadSession()).toBeNull()
    expect(storage.has('oxenfurt_session')).toBe(false)
  })

  test('leaves an ordinary paused session unchanged', () => {
    const saved = session(['a', 'b', 'c'], 1)
    saveSession(saved)
    expect(loadSession()).toEqual(saved)
  })

  test('does not consume a saved session when another practice mode is requested', () => {
    const saved = session(['a', 'b', 'a', 'c'], 2)
    saveSession(saved)
    expect(loadSession('translation')).toBeNull()
    expect(JSON.parse(storage.get('oxenfurt_session')!)).toEqual(saved)
  })
})

describe('adoptLegacyPause', () => {
  test('stamps a pre-scope pause with the default scope so it resumes again', () => {
    const saved = session(['a', 'b', 'c'], 1)
    delete (saved as Partial<PersistedSession>).scope
    saveSession(saved)

    // Before the upgrade the pause is invisible to every scope.
    expect(loadSession(undefined, 'english')).toBeNull()

    adoptLegacyPause('english')
    expect(loadSession(undefined, 'english')!.cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    // …and still does not leak into other scopes.
    expect(loadSession(undefined, 'go')).toBeNull()
  })

  test('leaves pauses that already carry a scope untouched', () => {
    const saved = session(['a', 'b'], 0)
    saveSession({ ...saved, scope: 'english' })
    adoptLegacyPause('go')
    expect(loadSession(undefined, 'english')!.cards).toHaveLength(2)
    expect(loadSession(undefined, 'go')).toBeNull()
  })

  test('no-op when nothing is paused', () => {
    adoptLegacyPause('english')
    expect(storage.has('oxenfurt_session')).toBe(false)
  })
})

