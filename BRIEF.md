# Oxenfurt — Project Brief (v2)

> Стартовый контекст для разработки. Зафиксированы решения, объём v1 и
> ограничения. Технологический стек после ресерча зафиксирован — не
> "Postgres или SQLite", а конкретные выборы с обоснованием. Решения
> по объёму v1 фиксированы; пункты "вне v1" — фиксированы как "не
> сейчас", но архитектура не должна закрывать дверь.

---

## 1. Контекст и мотивация

Пользователь (hb) — русскоязычный backend-разработчик, изучающий
английский с живым репетитором. Получает транскрипты уроков, которые
хочет превращать в структурированный учебный материал.

Текущая инфраструктура использует AI-агента (Hermes) в Telegram для
приёма транскриптов и извлечения словаря, повторяющихся ошибок и тем.
Чат-интерфейс Telegram фундаментально не подходит для структурированной
практики — нет UI для SRS, нет нормального флоу с карточками, нет
типов упражнений кроме плоского текста. Запускать словарный тест в
чате — больно.

**Этот проект — Telegram Mini App, который добавляет слой
структурированной практики поверх накопленных учебных данных.** Агент
остаётся слоем приёма и анализа; Mini App — UI для практики.

Долгосрочное видение: персональный английский тренер с разными
режимами тренировки (словарь, теория/правила, продуктивные упражнения,
speaking) поверх данных живых уроков. v1 — словарь и теория в едином
SRS-цикле. Остальные режимы — секция 7.

## 2. Существующая инфраструктура

- **Hermes Agent** (NousResearch) на VPS, нативная установка под systemd.
- Отдельный профиль `english` со своим Telegram-ботом.
- Systemd-юнит `hermes-english.service` держит gateway работающим
  независимо от другого Hermes-агента пользователя.
- `SOUL.md` настроен под персону "Regis" — коучинг-ориентированную, с
  суховатой честной интонацией, в режиме *только приёма данных*.
- Агент в текущей фазе:
  - Принимает транскрипты уроков из Telegram
  - Извлекает словарь, коллокации, ошибки, темы
  - Сохраняет в долговременной памяти
  - **НЕ** генерирует упражнения и не ведёт практические сессии
- Вся логика структурированной практики — ответственность Mini App.

## 3. Целевая архитектура

```
                          internet
                              │
                       ┌──────▼──────┐
                       │    Caddy    │  443/TCP, auto-TLS Let's Encrypt
                       └──┬───────┬──┘
                          │       │
         /api/* (proxy)   │       │   /, /assets/* (static)
                          │       │
              ┌───────────▼─┐  ┌──▼──────────────────┐
              │  oxenfurt-  │  │ /opt/oxenfurt/      │
              │  backend    │  │   mini-app/         │
              │  127.0.0.1: │  │   (Vite static dist)│
              │  3000       │  └─────────────────────┘
              └─────┬───────┘
                    │ TCP/socket (loopback)
                    │
              ┌─────▼─────────────┐
              │  Postgres 17      │  127.0.0.1:5432
              │  (single cluster, │
              │   database        │
              │   `oxenfurt`)     │
              └─────▲─────────────┘
                    │
                    │ POST /ingest/cards (loopback HTTP + Bearer)
                    │
              ┌─────┴───────────┐
              │ hermes-english  │  существующий systemd-юнит
              │ (Hermes agent)  │  принимает транскрипты, извлекает
              │                 │  vocab+theory, POST-ит в backend
              └─────────────────┘
```

- **Все компоненты на одном VPS** (Ubuntu, ≥2 GB RAM). Mini App — статика,
  Caddy подаёт её сам. Все non-Caddy слушают только 127.0.0.1.
- **Same-origin** для фронта и API через Caddy: `/api/*` проксируется
  в backend, всё остальное — на статику. Без CORS, без cookie-cross-domain.
- **Hermes интегрируется через loopback HTTP**: `127.0.0.1:3000/ingest/cards`
  с Bearer-токеном. Никакого общего БД-доступа — FSRS-состояние owned by
  Practice Backend.
- **Auth flow:** HMAC-валидация Telegram `initData` **один раз** на
  `/auth/session` → выдача собственного JWT (15 мин TTL) + single-user gate
  (`OWNER_TELEGRAM_USER_ID`). Refresh-токен хранится в Telegram
  **SecureStorage** (Bot API 9.0+). Фронт обновляет `initData` через
  `retrieveLaunchParams()` из SDK.
- **REST + JSON** между Mini App и backend. Схемы через **Valibot**, shared
  между front и back через monorepo пакет `packages/shared`.

- Mini App — SPA, открывается через inline-кнопку (`web_app`) из бота.
- **Auth flow:** HMAC-валидация Telegram `initData` **один раз** на
  `/auth/session` → выдача собственного JWT (15 мин TTL) + refresh-токена.
  Refresh-токен хранится в Telegram **SecureStorage** (Bot API 9.0+).
  Фронт обновляет `initData` через `retrieveLaunchParams()` из SDK.
- Mini App ↔ Practice Backend: **REST + JSON**, схемы через **Valibot**,
  shared между front и back через monorepo пакет `packages/shared`.
- Hermes-агент пишет новые карточки через REST endpoint бэкенда
  (`POST /ingest/cards` с internal-token auth). FSRS-состояние —
  собственность Practice Backend, агент только инициирует.

## 4. Стек (зафиксирован)

### Frontend (Mini App)
- **Vite + React 19 + TypeScript**
- **`@telegram-apps/sdk-react` v3** — Telegram WebApp API через сигналы
- **`@telegram-apps/telegram-ui`** — для нав/cells/start-screen
- **Radix + Tailwind с CSS-переменными `var(--tg-theme-*)`** —
  кастомные карточные компоненты (telegram-ui не покрывает свайпы/анимации)
- **Framer Motion** — микроанимации reveal/transition
- **TanStack Query** с persistent storage в IndexedDB
- **Valibot** — схемы и валидация
- **ts-fsrs 5.x** — FSRS-логика (используется и на бэке тоже)

### Backend (Practice service)
- **Bun** (latest stable, версия зафиксирована в `.bun-version`)
- **Hono** — first-class на Bun, всё нужное в коробке (CORS, secure
  headers, rate-limit через middleware)
- **Drizzle ORM** поверх `postgres.js` — миграции читаемым SQL
- **Postgres 17** на VPS, bind на 127.0.0.1
- **Valibot** — shared schemas из `packages/shared`
- **ts-fsrs 5.x** — единый источник FSRS-обновлений
- **`jose`** — JWT issue/verify (HS256, секрет в systemd env)

### Хостинг
- **Single-VPS, single-domain через Caddy** (см. `deploy/README.md`).
- Mini App статика → `/opt/oxenfurt/mini-app/` на VPS, Caddy подаёт.
  Альтернатива через Cloudflare Pages рассмотрена и отвергнута — добавляет
  CORS-сложность, разделяет деплой, выгоды CDN для single-user излишни.
- Practice Backend → `oxenfurt-backend.service` (systemd), нативный Bun,
  bind на 127.0.0.1:3000, фронтит Caddy.
- Postgres → нативный (`apt install postgresql`), bind на 127.0.0.1:5432.
  Один кластер, отдельная БД `oxenfurt`, отдельный role.
- Caddy — единственный публично доступный сервис, auto-TLS через
  Let's Encrypt.
- Бэкап БД → `pg_dump.gz` ежедневно через `oxenfurt-backup.timer`,
  rotation 14 дней локально + опционально rclone → R2/S3.

### Monorepo
- **pnpm workspaces** (Bun workspaces тоже работают; pnpm выбран
  ради зрелости и ровного DX в IDE)
- `apps/mini-app` — Vite-сборка фронта
- `apps/backend` — Bun-сервис
- `packages/shared` — Valibot-схемы, FSRS-обёртки, общие типы

### Аутентификация
- HMAC-валидация Telegram `initData` **только** в `/auth/session`
- Stateless JWT (15 мин), refresh-токен в SecureStorage Telegram
- Telegram user ID — субъект аутентификации
- Внутренний токен (UUID, в env) для Hermes → `POST /ingest/cards`

## 5. Обоснование стек-выборов

Кратко, чтобы не возвращаться к этим обсуждениям через два месяца.

- **Bun (не Node).** Встроенный `bun test` для TDD-цикла FSRS-логики и
  валидации `initData`. Native TS без `tsx`/`tsc-watch`. Hono на Bun
  идёт без shim. Profile зависимостей чистый (никаких корпоративных
  SDK), поэтому экосистемного риска нет. Memory safety net: в systemd
  юните `Restart=on-failure`, `MemoryMax=512M`.
- **Postgres (не SQLite).** Два писателя (Hermes + Practice Backend)
  без `SQLITE_BUSY` гонок. LISTEN/NOTIFY доступен на будущее. pgvector
  доступен на будущее (семантический поиск дубликатов словаря).
  `pg_dump` — простая backup-история. Ops-цена близка к нулю.
- **Drizzle (не Prisma).** Лёгкий (≈7 КБ), без codegen, мгновенный
  cold start, миграции — читаемый SQL. Для TDD-стиля выгоднее
  Prisma 7. Schema портабельная между Postgres и SQLite (на случай
  in-memory тестов).
- **Hono (не Fastify).** Web-standard `Request`/`Response`, меньше
  ментальной модели, всё в коробке, first-class на Bun.
- **REST (не tRPC).** Telegram WebView плохо дружит с batched POST'ами
  (видны stale ответы); ServiceWorker в TWA не запускается, поэтому
  offline-стратегия идёт через TanStack Query persistence — REST
  здесь проще. Type safety даёт Valibot-схемы в `packages/shared`.
- **Valibot (не Zod / не Typia / не ArkType).** Бандл 1–3 КБ
  tree-shaken (важно на мобильном TWA), API близок к Zod (миграция
  бесплатна), Standard Schema-совместим (можно поменять позже).
  Typia требует TS compiler transformer — несовместим с Bun-транспиляцией.
- **Telegram-UI + Radix-гибрид.** Telegram-UI закрывает list/settings,
  но не свайпы/анимации/карточный flow. Свои компоненты на Radix +
  Tailwind с переменными Telegram-темы — чтобы не получить
  "веб-страница в WebView".

## 6. Объём v1 (MVP)

Делать только это. Всё из секции 7 — вне объёма.

### 6.1 Интеграция с ботом
- Команда `/study` в английском боте открывает Mini App
- Inline-кнопка "Start practice" появляется в ответах агента после
  приёма нового транскрипта (если есть due-карточки)

### 6.2 Сессия повторения (один SRS-поток, два типа карточек)

Все карточки — vocab и theory — живут в **одной FSRS-очереди**. В
сессии они перемешаны (детерминируется только due-датой). Тип карточки
влияет на рендер и контент, но не на FSRS-логику и не на рейтинговые
кнопки. На карточке мелким серым в углу — badge типа (`📖 Theory`
или ничего для vocab).

**6.2.1 Vocab card — анатомия:**
- **Front (до reveal):** английский термин крупно +
  контекст-предложение из транскрипта с пропущенным словом
  (cloze-in-context). Источник ("Lesson 12, 03:14") — мелким серым.
- **Reveal:** тап **в любое место карточки** (вся поверхность —
  hit target). Не отдельная кнопка.
- **Back (после reveal):** перевод + полное предложение с подсветкой
  слова. Микроанимация fade 150–200 мс.

**6.2.2 Theory card — анатомия:**
- **Front (до reveal):** вопрос крупно (1-3 строки), badge "📖 Theory".
- **Reveal:** тот же tap-anywhere.
- **Back (после reveal):** ответ-объяснение (правило + пример), затем
  обязательная цитата из урока ("Из урока: *...*") мелким серым как
  source_quote. Если контент длиннее экрана — scrollable.

**Рейтинг:**
- Четыре кнопки в нижней четверти экрана, полная ширина, ряд:
  **Снова / Трудно / Хорошо / Легко** (Again/Hard/Good/Easy)
- Под каждой кнопкой — крошечный серый интервал следующего повторения
  ("через 10 мин / 1 д / 4 д / 9 д"). Скрывать нельзя.
- Touch target 56 dp, размещение в нижней четверти экрана (one-handed
  thumb reach)
- На первой сессии в жизни — onboarding-tooltip над кнопкой "Трудно":
  *"Вспомнил с усилием. Если не вспомнил — Снова."*

**Haptic feedback (Telegram SDK):**
- Reveal tap: `impactOccurred('light')`
- Again: `notificationOccurred('error')`
- Hard: `impactOccurred('medium')`
- Good: `selectionChanged()`
- Easy: `notificationOccurred('success')`
- Завершение сессии: `notificationOccurred('success')` **один раз**

**Прогресс сессии:**
- Тонкий progress bar сверху
- При тапе на bar — показывается счётчик "12 / 25"
- Без ETA, без эмодзи, без стриков, без конфетти

**Цикл:**
- Mini App забирает с бэкенда due-карточки (`scheduled_for ≤ now`)
- Каждый рейтинг применяет FSRS-обновление, сохраняет — карточка либо
  возвращается в очередь сегодня (Again), либо уходит на следующее
  повторение
- Цикл до опустошения очереди или выхода пользователя через BackButton
  (с confirm-sheet "Завершить сессию? Прогресс сохранён")

### 6.3 Draft-гейт для новых theory-карточек

AI-сгенерированный контент теории может галлюцинировать правила,
которых репетитор не давал. Чтобы не отравлять долгосрочное FSRS-расписание:

- Новая theory-карточка попадает в БД со `status='draft'` и НЕ
  включается в SRS-очередь.
- В Mini App на старт-скрене — баннер "Новых theory-карточек: N",
  открывает экран "Review new theory".
- На экране каждая draft-карточка показывается с действиями
  **Approve** (→ `status='active'`, попадает в FSRS-очередь) /
  **Skip** (→ `status='archived'`, исчезает) / **Edit** (правка
  question/answer/source_quote перед approve — для v1 опционально,
  можно отложить).
- Vocab-карточки проходят мимо этого гейта: создаются сразу в
  `status='active'`.

### 6.4 Empty / done states
- **All done today:** компактная статистика — *"25 карточек, 21 верно,
  следующая сессия завтра, 18 due"* + secondary action *"Повторить 5
  трудных"* (re-test без изменения FSRS-состояния).
- **No cards yet:** статус "Обрабатываю урок от 13.05" если агент
  работает, либо тихое сообщение "Загрузи транскрипт в чат, чтобы
  начать". Не "приходи завтра".

### 6.5 Мост для приёма данных
- Hermes-скилл POST-ит извлечённый контент на `POST /ingest/cards`
  бэкенда с internal-token auth (Bearer в header).
- Payload — discriminated union по `type`:
  - `vocab`: `{ term, translation, context_sentence,
    context_term_start, context_term_end, source, source_quote? }` →
    создаётся в `status='active'`.
  - `theory`: `{ question, answer, source, source_quote }` (где
    `source_quote` обязательная цитата из транскрипта) → создаётся в
    `status='draft'`.
- Бэкенд создаёт пустую FSRS-state (`createEmptyCard()` из ts-fsrs).
- **FSRS-состояние пишет только Practice Backend** — агент никогда.
- Дедупликация на стороне бэкенда: для vocab по нормализованному
  `term`, для theory — без дедупликации в v1 (полагаемся на draft-гейт).

### 6.6 Сводка сессии обратно в чат
- По завершении сессии Mini App через `Telegram.WebApp.sendData()`
  отправляет сводку
- Содержание: количество просмотренных, процент правильных, список
  слов на которых всё ещё спотыкается
- Агент получает сводку и может прокомментировать

## 7. Вне объёма v1

Запланировано на потом. В v1 НЕ делать. Не закладывать инфраструктуру
специально под это. Но и не загонять архитектуру в угол.

- Дополнительные типы упражнений: настоящий cloze deletion (с пустым
  полем для ввода), перевод RU→EN, сборка предложений, listening с
  TTS, multiple choice с AI-distractor-ами
- Speaking practice через Whisper STT и Claude как оценщик произношения
- AI-собеседник с after-action разбором ошибок
- Pattern detection (еженедельные / ежемесячные отчёты по
  повторяющимся типам ошибок)
- Трекинг CEFR-уровня и отчёты прогресса
- Browser extension для майнинга словаря из чтения
- MCP-сервер, отдающий прогресс другим Claude-клиентам
- Multi-user. Система — однопользовательская
- LISTEN/NOTIFY push от Hermes к бэкенду (поллинг достаточен в v1)
- pgvector для семантического поиска дубликатов словаря
- Optimistic updates через TanStack Query (добавить когда сеть начнёт
  бесить)

## 8. Принятые решения (фиксированные)

1. **Разделение приёма и практики.** Hermes-агент не генерирует
   упражнения и не пишет FSRS-состояние. Вся логика структурированной
   практики — Mini App + Practice Backend.
2. **SRS-алгоритм:** FSRS-5 через `ts-fsrs`. Не SM-2. Не самописный.
3. **Production over recognition (на будущее).** Будущие типы
   упражнений будут смещены в сторону продуктивных. v1 — только
   recognition + cloze-in-context на front-стороне.
4. **Реальный контекст обязателен.** Каждая словарная карточка несёт
   оригинальное предложение из транскрипта урока. Никаких абстрактных
   учебниковых примеров.
5. **Языковое разделение.** UI-обвязка — на русском. Учебный контент —
   на английском.
6. **Mobile-first.** Layout и взаимодействия под iOS и Android.
   Десктопный Telegram — best-effort.
7. **Один пользователь.** Никакой multi-tenancy. Auth ограничивает
   всё одним Telegram user ID.
8. **Нет gamification.** Без стриков, маскотов, конфетти,
   мотивационных уведомлений.
9. **Cloze-in-context в схеме карточки с v1.** Даже если визуально
   v1 показывает контекст с пропуском только декоративно — схема БД
   уже хранит позицию слова в предложении, чтобы v2 (настоящий cloze
   с вводом) не требовал миграции.
10. **Один SRS-поток для vocab и theory.** Общая таблица `cards`,
    общая FSRS-очередь, общие 4 кнопки рейтинга. Разделение через
    `cards.type` discriminator + JSONB `payload`. Theory-библиотека
    (read-only browse) — не v1.
11. **Draft-гейт для theory, не для vocab.** AI-генерация теории
    требует human-in-loop approval до попадания в FSRS-очередь, чтобы
    плохие карточки не отравляли долгосрочное расписание. Vocab идёт
    напрямую — извлечение слов из транскрипта ошибается реже и менее
    деструктивно.

## 9. Ограничения и подводные камни

### Telegram-специфика
- **Срок жизни `initData`:** 1 час с момента открытия. Валидируем
  один раз → JWT (15 мин) + refresh в SecureStorage. **Не**
  валидируем initData на каждом запросе.
- **iOS:** при сворачивании Telegram-клиент не всегда переинициализирует
  initData — auth_date протухает. Лови `viewportChanged` + проверяй
  expiry перед запросом.
- **Обязательно `disableVerticalSwipes()`** (Bot API 7.7+) для
  карточного flow — иначе вертикальный свайп при оценке закрывает
  Mini App.
- **`env(safe-area-inset-*)` не работает на iOS TWA.** Используй
  SDK-переменные `--tg-safe-area-inset-*`.
- **Кэш TWA агрессивный.** Vite content-hash для assets + `Cache-Control:
  no-cache` для `index.html` на бэке/CDN. ServiceWorker в TWA не работает.
- **CSS-переменные темы Telegram.** Не хардкодить цвета. Подписываться
  на `themeChanged` event — `colorScheme` иногда лагает на кадр.
- **`AppRoot platform={platform}`** обязателен для Telegram-UI, иначе
  на Android видишь iOS-стили.
- **MainButton** — только для "Начать сессию" / "Завершить" на
  стартовом и финальном экране. Внутри сессии 4 рейтинговые кнопки
  одновременно — внутри webview.
- **BackButton** в сессии — с confirm-sheet перед выходом.

### Конкурентная запись
- В Postgres пишут оба процесса (Hermes-агент через REST endpoint,
  Practice Backend напрямую). FK-целостность + transactions = всё
  переживает.
- **FSRS-состояние** — single writer = Practice Backend. Никогда не
  размазывать FSRS-логику.

### AI-генерация и hallucinations
- **Theory cards особенно опасны** — модель может уверенно сформулировать
  неверное правило. Митигации в v1: жёсткий промпт extraction-скилла
  Hermes ("только то, что прямо обсуждалось репетитором; если не уверен —
  пропусти; всегда давай `source_quote`"), draft-гейт на стороне Mini
  App, обязательный показ `source_quote` на back-стороне theory-карточки.
- Vocab — менее рискованно, дедупликация по term снижает шум.

### FSRS gotchas
- `enable_fuzz: true` — для prod, **отключить в тестах** (иначе
  снапшоты ломаются).
- `due` / `last_review` — UTC ISO в БД, парсить в `Date` на runtime.
- `request_retention` (default 0.9) — не менять на populated deck без
  re-scheduling прогона.
- Optimizer для индивидуальной подгонки параметров — запускать
  только после ~1000 reviews. До этого — default параметры FSRS-5.

### Стоимость токенов SOUL.md
- SOUL.md агента попадает в каждый промпт Hermes. Держать лёгким.
  Логику ingest-формата хранить в скиллах, не в SOUL.

## 10. Схема БД (минимальная для v1)

Drizzle, Postgres. Discriminated union через `type` + JSONB `payload`.
Поля FSRS-state — flat (нужны для индексов на `due` и фильтрации).
Type-specific поля — в JSONB, валидируются Valibot-схемами на
boundary (ingest, render).

```
cards
  id              uuid PK
  type            text NOT NULL                -- 'vocab' | 'theory'
  status          text NOT NULL DEFAULT 'active' -- 'draft' | 'active' | 'archived'
  payload         jsonb NOT NULL               -- type-specific shape
  source          text                         -- "Lesson 12, 03:14"
  source_quote    text                         -- цитата из транскрипта
  created_at      timestamptz NOT NULL DEFAULT now()
  -- FSRS state (flat для индексов)
  fsrs_state      smallint NOT NULL            -- 0=New, 1=Learning, 2=Review, 3=Relearning
  due             timestamptz NOT NULL
  stability       real NOT NULL
  difficulty      real NOT NULL
  elapsed_days    real NOT NULL
  scheduled_days  real NOT NULL
  learning_steps  smallint NOT NULL DEFAULT 0  -- ts-fsrs internal step pointer
  reps            int NOT NULL DEFAULT 0
  lapses          int NOT NULL DEFAULT 0
  last_review     timestamptz

  -- indexes
  idx_cards_due_active  ON (due) WHERE status='active'  -- горячий путь сессии
  idx_cards_status_type ON (status, type)               -- draft-гейт
  uniq_vocab_term       ON LOWER((payload->>'term'))    -- дедуп vocab
                         WHERE type='vocab'

-- payload shapes (валидация на бэкенде через Valibot)
-- vocab:  { term, translation, context_sentence,
--           context_term_start, context_term_end }
-- theory: { question, answer }

card_reviews
  id                bigserial PK
  card_id           uuid FK → cards.id ON DELETE CASCADE
  reviewed_at       timestamptz NOT NULL DEFAULT now()
  rating            smallint NOT NULL            -- 1=Again, 2=Hard, 3=Good, 4=Easy
  fsrs_state_before smallint NOT NULL
  fsrs_state_after  smallint NOT NULL
  stability_after   real NOT NULL
  difficulty_after  real NOT NULL
  elapsed_days      real NOT NULL
  scheduled_days    real NOT NULL

  idx_reviews_card  ON (card_id, reviewed_at)

sessions
  id              uuid PK
  started_at      timestamptz NOT NULL DEFAULT now()
  finished_at     timestamptz
  cards_reviewed  int NOT NULL DEFAULT 0
  cards_correct   int NOT NULL DEFAULT 0        -- rating >= Good
```

## 11. Предлагаемые первые шаги

1. **Скелет monorepo** (pnpm workspaces): `apps/mini-app`,
   `apps/backend`, `packages/shared`. Базовый CI на GitHub Actions:
   typecheck + lint + `bun test`.
2. **Скелет Practice Backend:** Bun + Hono + Drizzle + Postgres,
   эндпоинты `/health`, `POST /auth/session`,
   middleware JWT-проверки. Тесты валидации initData (HMAC) — TDD.
3. **Скелет Mini App:** Vite + React 19 + TypeScript, открывается
   внутри Telegram, делает `/auth/session`, показывает "Привет, {name}".
   `disableVerticalSwipes()`, theme variables, AppRoot.
4. **Схема БД:** Drizzle migrations для `cards`, `card_reviews`,
   `sessions`. Seed-скрипт с 20 тестовыми карточками.
5. **FSRS-модуль в `packages/shared`:** обёртки над `ts-fsrs` с
   `request_retention=0.9`, `enable_fuzz: false` в test-режиме.
   Unit-тесты для full lifecycle: New → Learning → Review.
6. **End-to-end цикл карточек:** fetch due → display
   (vocab или theory render) → tap-anywhere reveal → rate → persist
   FSRS update → fetch next. Haptic feedback. Bottom rating bar с
   интервалами.
7. **Интеграция с агентом:** `POST /ingest/cards` с internal-token,
   discriminated union vocab/theory. Hermes-скилл шлёт извлечённое.
8. **Draft-гейт экран:** список theory-карточек в `status='draft'`,
   действия Approve / Skip.
9. **Сводка обратно в чат:** `Telegram.WebApp.sendData()` при
   `finished_at`.

## 12. Профиль пользователя

- Сильные backend-навыки: TypeScript, Node, payment APIs, Kubernetes,
  PKI / mTLS, OpenSSL, Postgres.
- Frontend / React — опыт скромнее, но способен.
- Любит TDD; для бизнес-логики (FSRS-обновления, валидация `initData`)
  предпочитает test-first. `bun test` — основной раннер.
- Self-hosting на VPS. Уверенно с systemd, Docker, Linux ops.
- Русскоязычный, английский — intermediate / upper-intermediate.
- Предпочитает сжатую, прямую техническую коммуникацию. Без размытых
  преамбул. Без пустого энтузиазма.

---

*Конец брифа v2. Открытые вопросы и проектные решения, не покрытые
выше, делегируются на усмотрение реализации. При сомнениях —
выбирать более простой путь, который не перекрывает пункты из секции 7.*
