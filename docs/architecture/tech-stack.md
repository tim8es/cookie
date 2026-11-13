# Технический стек Cookie — shortlist и критерии выбора

**Статус: PROPOSED / НЕ УТВЕРЖДЁН.** Детальное обоснование и Gate: [ADR-0002](ADR-0002-technical-stack.md), GitHub Issue #10.

## Базовые требования
Быстрое бронирование, отсутствие двойных броней, минимальные расходы SaaS, self-hosted через Docker, единый frontend для сайта/виджета/Telegram Mini App, тонкий kernel, независимые business modules и доступная сопровождению сборка.

| Слой | Текущий shortlist | Статус / ограничение |
|---|---|---|
| Backend runtime | **Go** vs **Node.js + TypeScript** | Оба под оценкой, финальный выбор не сделан |
| Основной frontend | **Svelte 5**; React как сравнение, SolidJS резерв | Выбирать по UX, размеру JS, a11y и библиотекам |
| Build / web framework | **Vite**; SvelteKit только если он обоснован SSR/роутингом | Статическая SPA и SvelteKit SSR имеют разные требования к hosting |
| API contract | OpenAPI/JSON Schema, типизированный клиент | Независимо от backend языка |
| HTTP API | Go stdlib/chi или TS Fastify | HTTP framework = адаптер, не ядро |
| Module architecture | Минимальный kernel + ports/adapters | Согласован принцип, контракт ещё обсуждается |
| Storage | PostgreSQL | Предварительно поддержан, транзакционные механизмы в ADR-0003 |
| Persistence | TS: Drizzle/Kysely/SQL; Go: pgx/sqlc | После выбора языка и booking ADR |
| Jobs | PostgreSQL-backed: TS pg-boss / Go River и альтернативы | Реальные retries/outbox, не нужен Redis заранее |
| Frontend state | Framework native state + typed API; query cache по необходимости | Не добавлять global framework без практической потребности |
| Monorepo | Общая repo, TS pnpm / Go workspace при соответствующем выборе | Не навязывать один build orchestrator |
| Telegram | Выбрать SDK под runtime | Канал отдельно от доменной логики |
| Testing | Vitest/go test, Playwright, PostgreSQL integration/concurrency | Связать с contract tests и CI |
| Observability | Structured logs, tracing/correlation, DB metrics | Конкретные библиотеки после backend |
| Deployment | Docker Compose, versioned image, reverse proxy, CI/CD | Без Kubernetes и сложных брокеров в F1 |

## Нефункциональные метрики
- Mobile first: измерять LCP, INP, CLS на реальном интерфейсе и host странице embed, не делать вывод о быстродействии только по названию UI framework.
- Backend: измерять idle RAM, CPU, Docker image, p95/p99 booking API, конкуренцию и DB contention на одинаковой fixture.
- Пока **нет** обоснованных целевых RAM/JS/RPS значений: установить измеримые thresholds после технического spike и оценки цены VPS.
- Ускорение kernel/микросервисная извлекаемость не оправдывают динамические плагины с произвольным кодом на первом этапе.

## Важная развилка SvelteKit
SvelteKit не обязательно означает SSR, но SSR-режим может добавить отдельный runtime и сложность self-hosted. Svelte 5 + Vite со статической сборкой — более простой baseline для embedded booking. Решение о SSR принимать по SEO/маршрутам и on-boarding, а не «потому что современно».

## План проверки
**F0:** только ревью документации и критериев, без прототипов и code spikes.
**После разрешения F1:** ограниченный backend spike Go vs Node и UI smoke Svelte vs React только если без измерений решение не очевидно; зафиксировать ADR и начать продуктовую реализацию на одном стеке.

**Полный ADR:** [ADR-0002](ADR-0002-technical-stack.md).
