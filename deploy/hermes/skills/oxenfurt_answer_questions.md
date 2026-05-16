# Oxenfurt: Answer Card Questions

## Purpose

The learner can attach a free-form question to a specific Oxenfurt card
from the Mini App ("Что непонятно?"). Those questions land in
`card_questions` with `status='pending'`. This skill polls them, generates
an explanation grounded in the learner's actual lessons, and writes the
answer back. Optionally creates new related cards via the existing ingest
endpoint.

Triggered on a schedule (e.g. every 15 minutes) — never proactively in
chat. The learner reads answers in the Mini App, not in Telegram.

---

## Endpoints

Both routes use the same `OXENFURT_INGEST_TOKEN` Bearer auth as
`/ingest/cards`. On the same-VPS deployment:
`OXENFURT_API_URL = http://127.0.0.1:3000`.

### Poll pending questions

```
GET {OXENFURT_API_URL}/agent/questions/pending?limit=20
Authorization: Bearer {OXENFURT_INGEST_TOKEN}
```

Response:

```json
{
  "questions": [
    {
      "question_id": "uuid",
      "question": "Когда уместно использовать make а не do?",
      "created_at": "2026-05-16T14:23:00.000Z",
      "card": {
        "id": "uuid",
        "type": "theory",
        "payload": {
          "question": "When to use 'make' vs 'do'",
          "answer": "..."
        },
        "source": "lesson-2026-05-15",
        "source_quote": "You know, this 'make' vs 'do' thing..."
      }
    }
  ]
}
```

`card.payload` is the full type-specific payload (see
`oxenfurt_ingest.md` for the schemas). `card.source_quote` is the
tutor's exact words and is the most important context anchor.

### Post the answer

```
POST {OXENFURT_API_URL}/agent/questions/{question_id}/response
Authorization: Bearer {OXENFURT_INGEST_TOKEN}
Content-Type: application/json
```

```json
{
  "response": "**make** — для *создания* / *производства*..."
}
```

Response field: 1..10000 chars, **rendered as Markdown** in the Mini
App. Use the same conventions as `theory.answer` content (bold, italic,
inline code, lists, blank lines between paragraphs).

---

## Workflow per question

1. **Read the card and the question.** The card's `source` and
   `source_quote` are the strongest hints — these came from the
   learner's real lessons. If the source matches a transcript you have
   access to, pull the surrounding paragraph for context.

2. **Decide the form of the answer.** Three patterns:
   - **Clarification** (most common) — explain what the learner
     misunderstood, in Russian, with English examples. Tie it back to
     the source quote if useful.
   - **Comparison** — when the question is "разница с X" / "когда вот
     это, а когда то", produce a side-by-side block with examples.
   - **Recipe** — when the question is "когда уместно?", give 3-5
     example contexts (formal / casual / written / spoken / negative
     form, etc).

3. **Optionally create reinforcement cards.** If the answer naturally
   surfaces 1-3 closely-related vocab/phrase/theory items the learner
   doesn't yet have, send them through `POST /ingest/cards` (see
   `oxenfurt_ingest.md`). Set `source` to the same lesson as the
   original card. **Do not** spam — max 3 new cards per answered
   question.

4. **Post the response.** Be concise. ≤2000 chars in practice. No
   apology preamble, no meta ("я думаю что..."). Direct, didactic.

---

## Rules

- **One question at a time.** Each `question_id` gets exactly one
  response. If you fail to call the response endpoint, the row stays
  `pending` and will be retried on the next poll.
- **No retry on response endpoint failure** beyond one short pause
  (5 s). Log it and move to the next question.
- **Russian for explanations**, English for examples. Match the
  learner's apparent register.
- **Always tie answer to the source quote** when present. The learner
  came to this card from a real lesson — reference that.
- **Do NOT modify cards.** Editing is done by the learner in the Mini
  App. Your only writes are the response and (optionally) new ingest
  cards.

---

## Response style examples

### Clarification

> Вопрос: «Не понимаю разницу с `affect`».
>
> **`effect`** — обычно *существительное*: «эффект», «результат».
> Глагол *тоже* существует, но редко: «осуществить, привести к
> результату» (`to effect change`). На уроке препод сказал
> *"the effect was immediate"* — это именно существительное.
>
> **`affect`** — обычно *глагол*: «влиять».
>
> Запомни: `affect` *делает*, `effect` *является результатом*. Это
> грубая, но рабочая эвристика.

### Recipe

> Уместно говорить **"on the other hand"** когда:
>
> - вводишь **контраст** к только что сказанному
> - предполагаешь, что слушатель *взвешивает варианты*
> - в **письменной** речи и **формальных** разговорах
>
> *On the one hand, it's cheap. On the other hand, it's slow.*
>
> В дружеской беседе чаще скажут просто `but`.

---

## Error handling

| HTTP | `error` body  | Action |
|------|---------------|--------|
| 401  | (any)         | Wrong `OXENFURT_INGEST_TOKEN`. Alert. |
| 400  | `invalid_id`  | UUID malformed — skip this question, log. |
| 404  | `not_found`   | Question was deleted between poll and respond. Skip. |
| 500  | (any)         | Backend error. Retry once after 5 s; then skip. |
