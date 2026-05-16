# Oxenfurt Card Ingestion

## Purpose

After processing a lesson transcript, extract vocabulary and theory points
and write them to the Oxenfurt spaced-repetition backend.

This skill is triggered **after** a lesson transcript has been analyzed and
the learner explicitly confirms the extraction ("yes, add these", "save them",
etc.). Never offer to send cards to Oxenfurt proactively.

---

## Endpoint

```
POST {OXENFURT_API_URL}/ingest/cards
Authorization: Bearer {OXENFURT_INGEST_TOKEN}
Content-Type: application/json
```

Both variables are exposed to this agent via `EnvironmentFile`. Never
hard-code them.

On the host where Hermes-english and Oxenfurt share a VPS:
`OXENFURT_API_URL = http://127.0.0.1:3000` — loopback, no TLS needed.

---

## Payload schema

```typescript
{
  cards: Array<VocabIngest | TheoryIngest>   // 1..500 items
}

interface VocabIngest {
  type: 'vocab'
  payload: {
    term: string                  // 1..200 chars, the word / phrase
    translation: string           // 1..500 chars, Russian translation
    context_sentence: string      // 1..2000 chars, the original sentence
    context_term_start: number    // index where the term starts in context_sentence (0-based)
    context_term_end: number      // index where the term ends in context_sentence (exclusive)
  }
  source?: string                  // e.g. 'lesson-2026-05-15'
  source_quote?: string            // optional, exact sentence from transcript
}

interface TheoryIngest {
  type: 'theory'
  payload: {
    question: string              // 1..500 chars, the rule / grammar point
    answer: string                // 1..2000 chars, explanation with examples
  }
  source?: string                 // e.g. 'lesson-2026-05-15'
  source_quote: string            // REQUIRED for theory; tutor's exact wording
}
```

Response: `{ created: number, skipped: number }`.

---

## Rules

- **Only confirmed content.** Extract only what was directly discussed with
  the tutor. If a word appeared once in passing without comment, skip it.
- **If unsure — skip.** Better to miss a card than to create a wrong one;
  bad cards poison the FSRS schedule for weeks.
- **Vocab dedup is case-insensitive on `term`.** Sending the same term twice
  is safe — the second insert returns `skipped: 1`.
- **Theory has no dedup.** Each ingest creates a new active card. Duplicate
  questions accumulate; the learner can archive ones they don't want from
  the Mini App browse view (planned).
- **Everything enters the SRS queue immediately.** Both vocab and theory
  are written with `status='active'`. There is no approval step.
- **`source_quote` is mandatory on theory.** It is the learner's only
  pointer back to the original tutor utterance. Be generous with vocab too —
  include the original sentence whenever you have it.
- **Max batch size: 500.** Split larger lessons into chunks of 500.
- **Theory `question` and `answer` are rendered as Markdown.** Use
  formatting to make rules scannable:
    * `**bold**` for keywords ("**Формула**", "**Когда**", "**Маркеры**")
    * `*italic*` for English example sentences
    * `` `code` `` for grammatical patterns (`S + V`, `did + V`, `to + base`)
    * Bullet lists (`- item`) for multi-point rules
    * Blank line between paragraphs (otherwise the entire answer collapses
      into one wall of text — this is the single most common quality issue
      with auto-generated theory content)
  Vocab `term` / `translation` / `context_sentence` stay plain text — no
  formatting applied there.

---

## Full example

```http
POST http://127.0.0.1:3000/ingest/cards
Authorization: Bearer oxenfurt-ingest-token-abc123
Content-Type: application/json
```

```json
{
  "cards": [
    {
      "type": "vocab",
      "payload": {
        "term": "pragmatic",
        "translation": "прагматичный, практичный",
        "context_sentence": "We need a more pragmatic approach to this problem.",
        "context_term_start": 13,
        "context_term_end": 22
      },
      "source": "lesson-2026-05-15",
      "source_quote": "We need a more pragmatic approach to this problem."
    },
    {
      "type": "theory",
      "payload": {
        "question": "When to use **'make'** vs **'do'**",
        "answer": "**'make'** — for *creating* / *producing*:\n\n- make coffee\n- make a decision\n- make progress\n\n**'do'** — for *performing* / *executing*:\n\n- do homework\n- do the dishes\n- do a favour\n\nFixed collocations like `make progress` or `do a favour` just have to be memorised — there's no rule that derives them."
      },
      "source": "lesson-2026-05-15",
      "source_quote": "You know, this 'make' vs 'do' thing trips up a lot of my students..."
    }
  ]
}
```

```json
{ "created": 2, "skipped": 0 }
```

---

## Error handling

| HTTP | `error` body | Action |
|------|--------------|--------|
| 400  | `invalid_body`     | JSON couldn't be parsed. Re-serialise and retry once. |
| 400  | `invalid_payload`  | Schema mismatch. Log the `issues` array and report to the learner. |
| 401  | (any)              | Wrong / missing `OXENFURT_INGEST_TOKEN`. Configuration error — alert. |
| 500  | (any)              | Backend error. Retry once after 5 s; if still failing, report. |

---

## What this skill does NOT do

- It does NOT compute FSRS state (`due`, `stability`, `difficulty`, etc.) —
  the backend initialises that.
- It does NOT manage review schedules or session lifecycle.
- It does NOT open the Mini App for the learner — that's a separate
  capability of the bot (an inline `web_app` button on the message).
- It does NOT delete or update existing cards. Ingest is append-only;
  changes happen in the Mini App.
