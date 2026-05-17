<p align="center">
  <img src="docs/screenshots/home.png" width="200" />
  <img src="docs/screenshots/session.png" width="200" />
  <img src="docs/screenshots/library.png" width="200" />
  <img src="docs/screenshots/stats.png" width="200" />
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

---

## ⚖️ License

[MIT](LICENSE). Build, fork, and learn.

---

<p align="center">
  <i>Developed with affection for The Witcher universe.</i><br/>
  <b>Oxenfurt: Knowledge is the only true relic.</b>
</p>
