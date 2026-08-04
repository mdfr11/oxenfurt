# Oxenfurt: Compose an Assignment

## Purpose

Turn a finished lesson into a small, bounded, deadline-bound set of cards the
learner owes — the equivalent of "your tutor set this, and it's due Thursday".

The assignment becomes the **primary screen** of the Mini App. It is composed
out of cards that already exist; this skill never creates cards. Free practice
over the whole due queue stays available underneath and is untouched.

Why this exists: a bare "12 cards due" counter never got the learner to open
the app after a lesson. A named, finite, tutor-authored task does. The same
learner has also said plainly that they will not grind a large pile — so an
oversized assignment fails exactly as badly as no assignment. **Size is the
part of this skill that is easiest to get wrong.**

The backend enforces only structure — count, deadline sanity, card existence,
one-active-at-a-time. Everything about *what belongs in an assignment* is your
call, and this file is the whole of the guidance you get.

---

## When to run

- **Immediately after `oxenfurt_ingest` finishes for a lesson**, while the
  transcript is still in context. You need the transcript to know what the
  learner struggled with; you cannot reconstruct that from the API later.
- **On the regular poll**, if `GET /assignments/active` has no live assignment
  and more than **48 h** have passed since the most recent assignment was
  created. (`GET /assignments?limit=1` → `assignments[0].created_at`. The
  diagnostics `last_assignment` object does *not* carry `created_at`.)

Never proactively at any other time. Two assignments in a day is worse than
none.

---

## Endpoints

All four routes use the same `OXENFURT_INGEST_TOKEN` Bearer auth as
`/ingest/cards`. On the same-VPS deployment:
`OXENFURT_API_URL = http://127.0.0.1:3000`. Both variables come from
`EnvironmentFile` — never hard-code them.

```
GET  {OXENFURT_API_URL}/agent/diagnostics?limit=200   # where the learner is weak
POST {OXENFURT_API_URL}/agent/assignments             # create
GET  {OXENFURT_API_URL}/assignments/active            # is one live right now?
GET  {OXENFURT_API_URL}/assignments?limit=50          # history, newest first
```

`/assignments` and `/assignments/active` are the same routes the Mini App
uses; they accept either the learner's session JWT or your ingest token.

`GET /assignments/active` always returns an object, never a bare `null`:

```json
{ "assignment": null, "items": [] }
```

`assignment === null` is the "nothing live" signal. When one is live you get
the full `AssignmentDto` (`id`, `title`, `rationale`, `status`, `source`,
`created_at`, `due_at`, `completed_at`, `completed`, `total`, `groups`) plus
every item with its card payload.

---

## Reading the diagnostics

`GET /agent/diagnostics` is the only window you have into the learner's actual
memory. It returns three **overlapping** lenses plus context — a card can and
often does appear in more than one list. Never send the same `card_id` twice
in one assignment (the backend rejects it); dedupe before composing.

```jsonc
{
  "summary": {
    "active_cards": 412,   // everything not archived
    "overdue": 37,         // due strictly before now
    "due_today": 44,       // due before end of today (UTC)
    "leeches": 6
  },
  "overdue":  [ /* DiagnosticsCard[], soonest-due first */ ],
  "leeches":  [ /* lapses >= 4, most-lapsed first */ ],
  "fragile":  [ /* difficulty >= 7 AND stability <= 3 days, least-stable first */ ],
  "recent_sources": [
    { "source": "lesson-2026-07-28", "cards": 19, "latest": "2026-07-28T17:02:11.000Z" }
  ],
  "last_assignment": {
    "id": "uuid", "title": "…", "status": "expired",
    "due_at": "2026-07-25T18:00:00.000Z",
    "completed": 11, "total": 18,
    "unfinished_card_ids": ["uuid", "uuid", "…"]
  }
}
```

Each `DiagnosticsCard`:

```typescript
{
  card_id: string        // what you put in items[].card_id
  type: 'vocab' | 'phrase' | 'theory'
  label: string          // the term / phrase / question, clipped to 120 chars
  source: string | null  // 'lesson-2026-07-28'
  due: string            // ISO
  days_overdue: number   // 0 when not overdue
  lapses: number
  reps: number
  difficulty: number     // FSRS scale, 1..10
  stability: number      // days the memory is expected to hold
  last_review: string | null
}
```

What the numbers actually mean when you are choosing cards:

- **`days_overdue` is schedule debt, not difficulty.** A card 20 days overdue
  may simply have been missed during a busy fortnight. It says the schedule
  slipped; it says nothing about whether the learner finds the card hard.
  Useful for ordering the `weak` group, weak evidence on its own.
- **`lapses` is repeated forgetting.** This is the strongest signal in the
  payload. `lapses >= 4` is what puts a card in `leeches`: it has been learned
  and lost four or more times. These almost always deserve a slot.
- **`difficulty` is how hard the card fights back** — FSRS's per-card estimate,
  1..10, of how much effort each successful recall buys.
- **`stability` is how many days the memory is expected to survive.**
- **High `difficulty` with low `stability` is the interesting case, and it is
  why `fragile` exists as a separate list.** Such a card is *not yet overdue* —
  the scheduler is holding it together with short intervals — but the memory
  is thin and the card is expensive, so the next review is very likely to be a
  lapse. Catching it here is cheaper than catching it after it becomes a leech.
  Do not skip `fragile` cards because `days_overdue` is 0; being on time is the
  whole point.
- **`recent_sources`** tells you which lesson the newest cards came from —
  use it to find the `new` group when you are running on the poll rather than
  straight after an ingest.

---

## Payload schema

```
POST {OXENFURT_API_URL}/agent/assignments
Authorization: Bearer {OXENFURT_INGEST_TOKEN}
Content-Type: application/json
```

```typescript
{
  title: string          // 1..120 chars, trimmed
  rationale?: string     // 0..2000 chars, rendered as Markdown in the Mini App
  due_at: string         // ISO 8601 timestamp
  source?: string        // 1..200 chars, e.g. 'lesson-2026-07-28'
  replace?: boolean      // default false — see "Single active assignment"
  items: AssignmentItem[]  // 3..30 items; TARGET ~20
}

interface AssignmentItem {
  card_id: string        // uuid of an EXISTING, ACTIVE card
  group_label: string    // 1..80 chars, shown as a section header in the app
  group_kind: 'new' | 'topic' | 'weak'
}
```

Item order in the array **is** the order the learner sees. Items sharing a
`group_label` are folded into one section, in first-appearance order — so keep
each group contiguous in the array. Keep `group_kind` consistent within a
label: the section takes the kind of its first item and the rest are ignored
for display.

Response: `{ "assignment_id": "uuid", "items": 20 }`.

---

## Composing the assignment

### 1. Unfinished work goes in first

Read `last_assignment.unfinished_card_ids` from the diagnostics. Those cards go
at the **top of the `items` array, before anything else**, in their own group.
The learner owed them and did not take them; dropping them silently teaches
that assignments can be waited out.

Give them `group_kind: 'weak'` and a label that names them for what they are
(«Долг с прошлого задания»). The exception: a card that is unmistakably part of
the lesson you just processed belongs in the `new` group instead — presenting a
two-day-old word as a failure is wrong.

If the unfinished list is long, it can legitimately eat most of the assignment.
Take up to about 8; leave the rest for next time rather than blowing the budget.

### 2. Then the three kinds

Label every item with the kind that explains *why it is there*. The Mini App
groups and styles by these.

- **`new`** — vocabulary, phrases and rules from the lesson you just processed.
  The learner's memory of the lesson is the hook that gets them to open the
  app; this group should never be empty right after an ingest.
- **`topic`** — the one thing the learner visibly struggled with in the
  transcript. Not "everything about conditionals" — the specific point the
  tutor had to explain twice. Pull existing cards on that point, including old
  ones that are not due; a topic group is a deliberate re-teach, not a review.
- **`weak`** — leeches and fragile cards from the diagnostics. Order by
  `lapses` first, then by low `stability`. Deep overdue cards go here too when
  there is room.

A good shape after a lesson: ~4 unfinished, ~8 `new`, ~4 `topic`, ~4 `weak`.
On a poll run there is no fresh lesson, so it will be mostly `weak` with a
`topic` group built from whatever the most recent `recent_sources` entry covers.

### 3. Size: target ~20, not 30

The backend accepts 3..30. **30 is the ceiling, not the target.** Aim for about
20 and never exceed 25 without a specific reason.

The ceiling is where the backend stops calling it an assignment. The target is
where the learner actually finishes it. Those are different numbers, and the
gap is the entire point: this learner bounces off large piles — that failure is
what the feature exists to fix, and a 30-card assignment reproduces it exactly.
An unfinished assignment is worse than a small one, because it rolls forward
into the next one (step 1) and compounds.

If you have 40 excellent candidates, ship 20 and let the other 20 be next
week's assignment. Cards do not expire.

### 4. Voice

- **`title`** is concrete and human, and names the material:
  «Условные предложения и лексика 28 июля». Never «Задание №4», never
  «Assignment 2026-07-28». The learner reads this on the home screen and in a
  Telegram notification; it has to sound like a person set it.
- **`rationale`** is two or three sentences in the tutor's voice explaining
  *this* selection — why these cards, why now. It is rendered as Markdown, so
  `**bold**` and `*italic*` work; keep it to prose, no bullet lists, no
  headings. Address the learner directly. Do not restate the counts, the app
  already shows them.
- **`group_label`** is a section header in Russian, 80 chars max, specific
  enough to be worth reading: «Новые слова с урока», «Условные предложения»,
  «Слова, которые упорно забываются».
- **`source`** should be the lesson id you ingested (`lesson-2026-07-28`) so
  the assignment can be traced back to its transcript.

---

## Rules

- **Cards must already exist and be active.** `card_id`s come from
  `/agent/diagnostics` or from a `POST /ingest/cards` you just made. Archived
  and draft cards are rejected as `unknown_cards`. Ingest first, then compose.
- **No duplicate `card_id`s** in one payload — `400 duplicate_cards`. The three
  diagnostics lists overlap, so dedupe explicitly.
- **`due_at` is the day before the next scheduled lesson**, at an evening hour
  the learner is realistically free (e.g. `21:00` their time). That gives a
  full day of slack and lands the finish right before they next see the tutor.
  If you do not know the schedule, use **three days out**. Never beyond **30
  days** — the backend rejects it — and never in the past: `due_at` must be
  strictly in the future or you get `400 invalid_due_at`.
- **Expiry is silent and automatic.** When `due_at` passes, the assignment
  flips to `expired` on the next read. Nothing is deleted; the unfinished cards
  come back to you through `last_assignment.unfinished_card_ids`.
- **The assignment completes itself** when every non-archived item has been
  rated Good or better once. You do not mark anything.
- **Single active assignment.** Creating one while another is live returns
  `409 assignment_active` (with `assignment_id` when the backend can name it).
  **Do NOT retry with `replace: true` automatically.** An unfinished assignment
  is information, not an obstacle: it means the learner has not done the last
  thing you set, and replacing it hides that from both of you. On a 409, stop
  and say nothing. Send `replace: true` only when the learner explicitly asks
  for a new assignment.
- **In-app repeats are not new measurements.** Within an assignment session the
  learner may take the same card several times; only the first rating of the
  day reaches FSRS. That is the Mini App's business — you never send ratings.

---

## Notifications

This is the only part of the system that is allowed to interrupt the learner,
and the budget is deliberately tiny.

- **Exactly one Telegram message on successful creation**, with an inline
  `web_app` button opening the Mini App. Lead with the title and the deadline.
- **At most one reminder**, sent **no earlier than 24 h before `due_at`**, and
  only after re-checking `GET /assignments/active` — send it only if the same
  assignment is still `active` and `completed < total`.
- **Nothing else. Ever.** No "you haven't opened the app", no daily digest, no
  streak nudge, no message when an assignment expires.

The app itself never nags either, and that restraint is the design: accumulated
guilt is exactly what made the plain due-queue demotivating. A missed
assignment should cost nothing but quietly reappear in the next one.

---

## Full example

Diagnostics come back showing 6 leeches, a stack of fragile conditionals, and
an expired assignment with 7 cards untaken. The lesson of 28 July has just been
ingested. The next lesson is Thursday 6 August.

```http
POST http://127.0.0.1:3000/agent/assignments
Authorization: Bearer oxenfurt-ingest-token-abc123
Content-Type: application/json
```

```json
{
  "title": "Условные предложения и лексика 28 июля",
  "rationale": "На уроке второй тип условных предложений пришлось разбирать дважды — собрал сюда все карточки по нему, включая старые. Плюс новые слова с прошлого занятия и четыре, которые ты стабильно забываешь: *reluctant* висит с мая.\n\nДо среды успеешь спокойно, по 5-7 карточек в день.",
  "due_at": "2026-08-05T18:00:00.000Z",
  "source": "lesson-2026-07-28",
  "items": [
    { "card_id": "3f1c…", "group_label": "Долг с прошлого задания", "group_kind": "weak" },
    { "card_id": "9a20…", "group_label": "Долг с прошлого задания", "group_kind": "weak" },
    { "card_id": "c7b4…", "group_label": "Долг с прошлого задания", "group_kind": "weak" },

    { "card_id": "1e88…", "group_label": "Новые слова с урока 28 июля", "group_kind": "new" },
    { "card_id": "44d1…", "group_label": "Новые слова с урока 28 июля", "group_kind": "new" },
    { "card_id": "b902…", "group_label": "Новые слова с урока 28 июля", "group_kind": "new" },

    { "card_id": "77ea…", "group_label": "Условные предложения", "group_kind": "topic" },
    { "card_id": "0c53…", "group_label": "Условные предложения", "group_kind": "topic" },

    { "card_id": "5db6…", "group_label": "Упорно забываются", "group_kind": "weak" },
    { "card_id": "aa17…", "group_label": "Упорно забываются", "group_kind": "weak" }
  ]
}
```

*(Abridged — the real payload carries ~20 items: 3-4 unfinished, ~8 `new`,
~4 `topic`, ~4 `weak`.)*

```json
{ "assignment_id": "d24a1f6e-…", "items": 20 }
```

Then, once:

> **Условные предложения и лексика 28 июля**
> 20 карточек, до среды вечера.
> [Открыть] ← inline `web_app` button

---

## Error handling

| HTTP | `error` body | Action |
|------|--------------|--------|
| 400  | `invalid_body`      | JSON couldn't be parsed. Re-serialise and retry once. |
| 400  | `invalid_payload`   | Schema mismatch — count outside 3..30, over-long `title`, bad `group_kind`. Log the `issues` array and report to the learner. |
| 400  | `invalid_due_at`    | `due_at` is in the past, equal to now, or more than 30 days out. Recompute the deadline and retry once. |
| 400  | `unknown_cards`     | Response carries `card_ids` — ids that don't exist or aren't active. Drop exactly those, retry **once**. If the remainder falls below 3 items, abort. |
| 400  | `duplicate_cards`   | The same `card_id` appears twice. Dedupe and retry once. |
| 409  | `assignment_active` | One is already live. **Do not retry.** Do not set `replace: true`. Stop silently. |
| 401  | `unauthorized`      | Wrong / missing `OXENFURT_INGEST_TOKEN`. Configuration error — alert. |
| 500  | `internal_error`    | Backend error. Retry once after 5 s; if still failing, report. |

Never retry a create more than once for the same reason: a duplicate
assignment cannot happen (the 409 blocks it), but a spurious one that replaces
the learner's real work can.

---

## What this skill does NOT do

- It does NOT create cards. Every `card_id` must already exist — use
  `oxenfurt_ingest.md` first, then compose from what it created.
- It does NOT compute or touch FSRS state (`due`, `stability`, `difficulty`,
  `lapses`). Reading it from diagnostics is the extent of your involvement.
- It does NOT mark items complete. The backend does that when the learner
  rates a card Good or better in the Mini App.
- It does NOT delete or edit assignments. There is no update endpoint;
  `replace: true` on a new create is the only way to displace a live one, and
  it needs the learner's explicit ask.
- It does NOT answer card questions — that's `oxenfurt_answer_questions.md`.
