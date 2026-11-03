<p align="center">
  <img src="docs/screenshots/demo.gif" width="320" />
</p>

# Oxenfurt

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.3-black?logo=bun)](https://bun.sh)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![Telegram](https://img.shields.io/badge/Telegram-Mini_App-26A5E4?logo=telegram)](https://core.telegram.org/bots/webapps)

> **Your private knowledge academy.** A self-hosted Telegram Mini App that turns transcripts of your live language lessons into spaced-repetition flashcards.

Named after [Oxenfurt Academy](https://witcher.fandom.com/wiki/Oxenfurt_Academy) from *The Witcher* — the city where everyone goes to learn.

---

## 🏛 The Concept

You finish a 60-minute session with your tutor. Your head is full of 20 new words and three grammar points. But you didn't write them down. By tomorrow morning, 50% is gone.

**Oxenfurt closes the loop:**
1.  **Ingest**: Your lesson transcript is processed by an AI agent (Hermes).
2.  **Generate**: The agent extracts the *actual* vocabulary you discussed, complete with context sentences from your conversation.
3.  **Learn**: Open your Telegram bot. Practice using **FSRS-5** (the gold standard of SRS) with a premium, Tinder-style interface.
4.  **Resolve**: Confused? Ask the agent. It remembers the lesson and explains the nuance in Markdown.

---

## ✨ Features

### 📋 Tutor-Style Assignments
After each lesson the agent composes a bounded, deadline-bound set of ~20 existing cards — new material, the point you struggled with, and what you keep forgetting — and that assignment becomes the app's primary screen until it's done or its deadline passes. A finished assignment stays replayable in unlimited "circles" from Home or history, so one pass is never treated as proof of knowing it. Free practice over the full due queue stays available underneath, untouched.

### 🎓 Multiple Scopes (Several Academies)
One app, many decks. Declare scopes in the backend env (`SCOPES=english:English:🇬🇧:indigo,go:Go:🐹:emerald`) and give each Hermes profile its own ingest token (`INGEST_TOKENS=go=…`). Each agent then owns exactly one deck — its token *is* its scope, so a bot physically cannot write into another academy. Inside the Mini App a pill switcher under the header swaps the whole context: assignment, due queue, stats and accent color. Assignment slots, card dedup, streaks and heatmaps are all per-scope.

### 🧠 Advanced Spaced Repetition
Powered by **FSRS-5** (Free Spaced Repetition Scheduler). Unlike basic Anki, it adapts to your memory curve per-card, minimizing review time.
- **5 Practice Modes**: Recognition, Cloze (gap-fill), Translation, Listening (TTS), and Mixed.
- **Undo Window**: Made a mistake? Tap undo within 3.5s.
- **Smart Replay**: Opt-in to re-see failed cards in the same session.

### 🎨 Witcher-Inspired "Dark Academia" UI
A premium, polished interface using an independent **Zinc/Indigo** palette.
- **Tinder-style swipes**: Tactile feedback and colored tints (Emerald for Easy, Rose for Again).
- **Academic Archives**: Track your progress with GitHub-style heatmaps and "Relics" (achievements).
- **Haptic Engine**: Deep integration with Telegram's haptic feedback for every interaction.

### 🛡 Self-Hosted & Private
Your data belongs to you. No SaaS, no monthly fees, no tracking.
- **Full Control**: Export your entire knowledge base in JSON anytime.
- **Agent Agnostic**: Works with any OpenAI-compatible API (Anthropic, Groq, Ollama, Moonshot).

---

## 🚀 Quick Start (One-Shot Install)

Deploy your own instance on any Ubuntu/Debian VPS in ~3 minutes:

```bash
curl -fsSL https://raw.githubusercontent.com/mdfr11/oxenfurt/master/deploy/install.sh | bash
```

> [!TIP]
> First-time setup? Append **`--with-demo`** to seed ~30 example cards across three lessons:
> `… | bash -s -- --with-demo`

**Requirements:**
1. A [Telegram Bot Token](https://t.me/BotFather).
2. Your [Telegram User ID](https://t.me/userinfobot).
3. A domain pointed at your VPS (e.g., `oxenfurt.yourname.com`).

---

## 🛠 Tech Stack

| Layer | Choice | Why? |
| :--- | :--- | :--- |
| **Runtime** | Bun 1.3 | Instant boot, single binary efficiency. |
| **Backend** | Hono + Drizzle | Lightweight, type-safe, blazing fast. |
| **Frontend** | React 19 + Vite | The cutting edge of web performance. |
| **Styling** | Tailwind 4 + Framer Motion | Smooth 60fps transitions and "Modern App" feel. |
| **Database** | Postgres 17 | Solid reliability for your knowledge base. |
| **Algorithm** | FSRS-5 | Scientific SRS that beats Anki's SM-2. |

---

## 📡 Agent Integration

Oxenfurt is built for **Hermes Agent**. The agent reads your Zoom/Google Meet transcripts and POSTs cards to your private backend.

- **Ingest Spec**: [`deploy/hermes/skills/oxenfurt_ingest.md`](deploy/hermes/skills/oxenfurt_ingest.md)
- **Answer Spec**: [`deploy/hermes/skills/oxenfurt_answer_questions.md`](deploy/hermes/skills/oxenfurt_answer_questions.md)
- **Assignment Spec**: [`deploy/hermes/skills/oxenfurt_assignments.md`](deploy/hermes/skills/oxenfurt_assignments.md)

---

## 🔒 Security & Threat Model

Oxenfurt is **single-user by design**. Read this before deploying.

- **One operator, one Telegram account.** The backend gates session creation on a single `OWNER_TELEGRAM_USER_ID`. There is no per-user data isolation in the schema, no role system, no tenant boundary. Do not deploy multi-tenant — every authenticated request can read every card.
- **Loopback-bound backend.** The Bun server binds to `127.0.0.1`. TLS termination is Caddy's job. If you replace Caddy, make sure whatever fronts the backend strips `Forwarded` headers and never re-exposes the backend port directly.
- **Telegram WebApp HMAC is the only auth at session mint time.** A leaked `BOT_TOKEN` lets an attacker mint sessions for your user ID. Rotate via @BotFather if you ever suspect leak.
- **`ENABLE_DEV_AUTH` must stay `false` in production.** The backend refuses to boot otherwise, but don't tempt it.
- **Third-party proxies.** `/translate`, `/tts`, and `/grade` forward user input to MyMemory, Google Translate, and your configured LLM provider respectively. They share your VPS IP — if your JWT secret leaks (15-min TTL), the holder gets free proxy access until the token expires.
- **Prompt injection in `/grade`.** A user-typed answer is sent verbatim to the LLM with quoted interpolation. Single-user means "you can cheat at your own flashcards" — wontfix. Anyone forking for a multi-user deployment must escape or structure the prompt instead.
- **Hermes webhook is optional + HMAC-signed** (`HERMES_WEBHOOK_SECRET`). No replay protection — the loopback assumption makes it cheap, but document the constraint if you ever cross a network boundary.

If you find a real security issue, open a private advisory on GitHub rather than a public issue.

---

## ⚖️ License

[MIT](LICENSE). Build, fork, and learn.

---

<p align="center">
  <i>Developed with affection for The Witcher universe.</i><br/>
  <b>Oxenfurt: Knowledge is the only true relic.</b>
</p>
