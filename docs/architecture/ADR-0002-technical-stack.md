# ADR-0002 — Выбор стека по требованиям Cookie, а не по привычным технологиям

**Статус:** PROPOSED / сравнение открыто · Issue #10 · 2026-11-13.
**Блокирует:** утверждение F0 для backend/frontend.
**Не разрешает:** писать код приложения или benchmarking spike до отдельного approval владельца.

## Контекст
Cookie — платформа записи для малых салонов (2–10 сотрудников), поддерживает SaaS и self-hosted, одно Booking API, Telegram и общий web/embedded/Mini App интерфейс. Нужны низкие RAM/CPU/операционные расходы, хорошая мобильная отзывчивость, модульность и поддержка одним разработчиком с Codex. Полноценный реальный микросервисный ландшафт в F1 не нужен.

### Не обсуждается в этом ADR
- **Уже согласовано:** минимальное plugin kernel, модульный монолит, одна бизнес-логика для всех каналов, независимые API-контракты, PostgreSQL как предварительно обоснованный выбор (окончательно проверить в booking ADR), отсутствие преждевременных микросервисов.
- **Открыто:** runtime backend; frontend framework и режим рендеринга; HTTP framework; database access/migrations; job runner; tooling монорепозитория; тестовый стек.

## Решение о подходе к выбору (принято направление, не стек)
Никакая комбинация Node.js/React/Vite не считается утверждённой. 
- Backend сравнить **Go** и **Node.js + TypeScript** на одинаковых требованиях. Go не исключается по причине нового языка; Node.js не выбирается автоматически из-за общего TypeScript.
- Frontend основной кандидат **Svelte 5**; **React** — контрольная альтернатива; **SolidJS** остаётся резервом, если реальная проблема с DOM performance. Vite — инструмент сборки, а не аргумент в пользу React.
- **SvelteKit vs Svelte+Vite — отдельная развилка.** SvelteKit с SSR может потребовать отдельный серверный runtime, в том числе Node.js (зависит от adapter), даже если основной backend Go. Если SEO-публичной витрины не требуется, Svelte/Vite SPA со статическими файлами проще и легче в self-hosted. SvelteKit можно использовать в режиме static/prerender/SPA или как отдельное SSR-приложение только при доказанном продуктовым спросом требовании. Решить после описания страниц и индексации.
- Монорепозиторий остаётся, но **pnpm workspaces** нельзя объявлять единственным инструментом, пока backend Go остаётся возможным. Можно использовать Go workspaces + pnpm только для frontend, без тяжёлых orchestrators.
- **PostgreSQL** кандидат на primary DB; гарантии отсутствия двойной записи — DB constraints и синхронные транзакции независимо от языка (ADR-0003). SQLite для локальных MVP тестов не подменяет проверку PostgreSQL.
- Фоновые задания: PostgreSQL-backed solution без отдельного Redis пока нагрузка этого не требует. Для TS сравнить pg-boss/альтернативу; для Go сравнить River/альтернативу. Независимый порт заданий должен не раскрывать конкретную библиотеку доменным модулям.

## Критерии и метод выбора

| Критерий | Что именно проверять | Почему важно |
|---|---|---|
| Целостность брони | транзакционное создание, reschedule, блокировки, идемпотентность | продукт не имеет права делать двойные брони |
| Ресурсы | idle RAM, RAM/CPU под типовой нагрузкой API+jobs, размер Docker-образа | низкие цены SaaS и self-hosted на дешёвом VPS |
| Latency/concurrency | p50/p95/p99 read slots и booking при разных параллельных клиентах | UX и стабильность при всплесках |
| Операционная сложность | число runtime/process, установки/обновления, backup/restore | solo maintenance |
| Модульность | независимость ports/adapters, тест отключения add-on, extracted remote mock | не создавать Big Core |
| Стоимость и скорость изменения | объём кода, сложность тестирования, сборка/CI, генерация контракта | agentic development и сопровождение |
| Frontend UX | JS transfer, hydrated JS, мобильный INP/LCP/CLS, memory/scroll responsiveness | лёгкий быстрый календарь и Mini App |
| Общее UI | одинаковое поведение public page / iframe / Telegram Mini App, безопасная auth | единая кодовая база и адаптеры |
| Экосистема | проверенные calendar/form/a11y библиотеки и обновляемость | не писать тяжёлые компоненты с нуля |

### Два этапа оценки
**F0 — только документальный выбор.** Проверить документацию и варианты, описать критерии; выбрать условное направление. Зафиксировать измеримый budget/probe plan. **Никакого кода и benchmark в F0.**

**После явно разрешённого старта F1** — если выбор всё ещё зависит от производительности, выполнить краткий изолированный technical spike как первую инженерную задачу, *не* создавать полноценное приложение на двух стеках. Одинаковая DB fixture, одно API чтения доступности + atomic booking + 1 job, одинаковые параметры VPS/контейнера, измерение ресурсов/latency и сложности сопровождения; для UI — одна интерактивная форма календаря на Svelte и React, одинаковые API/состояния и аудит Lighthouse/DevTools в мобильном профиле. Spike требует отдельного approval и явной границы времени. Потом выбрать стек и обновить ADR до ACCEPTED.

### Предварительный shortlist, без рейтинга и выдуманных метрик
**A. Go + Svelte/Vite (статический UI).** Одна compiled backend сборка, статический frontend, Go ports/modules; минимальные runtime-зависимости, но два языка и typed clients через OpenAPI, Go-specific SDK интеграций.

**B. Node.js/TS + Svelte/Vite (статический UI).** Один язык TS, высокая скорость интеграций, отдельный Node runtime и контроль event-loop/worker задач.

**C. Go/Node + SvelteKit SSR.** Только при подтвержденной нужде SSR/SEO: дополнительная операционная сложность в зависимости от адаптера, не основной baseline.

**Контроль frontend:** React/Vite с тем же набором UI; не считать React по умолчанию тяжёлым или Svelte автоматически быстрым.

### Предварительные budgets (целевые, не измеренные факты)
- Core Web Vitals: LCP <= 2.5s, INP <= 200ms, CLS <= 0.1 при соответствующем percentile и device profile. Для embed измерять реальный host page + widget, а не только изолированную iframe-страницу.
- Бюджеты JS payload/RAM и серверные SLO (RPS, CPU, p95) устанавливаются после F1 измерений на целевой инфраструктуре, с реальным календарём и данными.
- Accessibility и корректность исключений графика важнее выигранных миллисекунд синтетического теста.

## Остальные компоненты
- HTTP: Fastify (Node)/chi или stdlib net/http (Go); API контракт OpenAPI с явной auth/error schema, генерация TS клиента при Go.
- Database access: Drizzle/Kysely/SQL (TS), pgx/sqlc (Go), SQL migration pipeline общий в концепции, выбор после ADR-0003.
- Queues: pg-boss/Postgres-based для TS, River/эквивалент для Go; гарантия идемпотентности/восстановления по тестам, не по обещаниям.
- Тестирование: Playwright web E2E, Vitest для TS, go test для Go, PostgreSQL integration и concurrency tests; инструменты не определяют архитектуру.
- Docker Compose + GitHub Actions — базовое направление; reverse proxy/TLS выбрать в deployment ADR. Kubernetes/Redis не вводить без необходимости.

## Риски и альтернативы
- Go + SvelteKit SSR под Node может снова потребовать два backend runtimes — избегать без SEO ценности.
- Svelte и React имеют разные наборы сложных calendar/grid компонентов; проверить доступность и лицензии до выбора.
- Go не решит DB contention автоматически; более дорогая разработка может съесть экономию в RAM.
- Node.js экономит контекст переключения TS/Go, но нуждается в ограничении CPU-bound workloads и мониторинге event loop.
- «Поддержка микросервисов» проверяется контрактными границами, не размером бинарника.

## Gate / как закрыть Issue #10
- [ ] Утверждён документ критериев выбора и shortlist.
- [ ] Определён режим frontend — static SPA или SSR, с SEO обоснованием.
- [ ] Получено решение владельца по provisional backend/frontend.
- [ ] Если сравнение требует кода, отдельно согласовано, что spike происходит **после** F0 approval.
- [ ] Версии/dependencies frozen только при engineering bootstrap #16.
- [ ] Проставлено ACCEPTED и проверена согласованность ADR-0002, tech-stack.md, register.md и Issue #10.

**Исходные документы:** https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop ; https://go.dev/doc/effective_go ; https://svelte.dev/docs/kit/page-options ; https://svelte.dev/docs/kit/adapters ; https://vite.dev/guide/
