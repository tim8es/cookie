# Технический стек: предварительный выбор

**Статус: PROPOSED.** Конкретные версии зафиксируем непосредственно перед bootstrap; Node.js поддерживаемый LTS.

| Слой | Кандидат | Почему / компромисс |
|---|---|---|
| Язык | TypeScript + Node.js LTS | Общая типизация web/backend, скорость агентной разработки |
| Монорепозиторий | pnpm workspaces | Меньше infrastructure overhead, общий lockfile; Turbo/Nx только по потребности |
| HTTP API | Fastify + JSON Schema/TypeBox + OpenAPI | Лёгкий адаптер, schema validation; Fastify plugins не являются domain modules |
| Внутренние модули | Pure TS, ports/adapters, compile-time registry | Минимальный kernel и управляемые контракты без arbitrary plugins |
| Хранилище | PostgreSQL | Транзакции, ограничения перекрытий, надежность |
| Data access | Drizzle + reviewed SQL migrations | Типизированные запросы, полный SQL контроль; альтернатива Kysely |
| Фоновые задачи | pg-boss или аналог на Postgres | Нет Redis и отдельного брокера в F1; проверить поддержку/maintenance |
| Web | React + Vite + TypeScript | Общий UI для web, Mini App и iframe widget |
| Web data | TanStack Query | Server state; не вводить сложный global store до необходимости |
| Telegram | Bot API, библиотека выбрать перед реализацией | Telegram adapter изолирован от business |
| Тесты | Vitest, Playwright, Postgres integration/Testcontainers | Unit, contract, UI, concurrency |
| Логи | Pino structured logs, metrics | Корреляция, диагностика, ошибки |
| Развёртывание | Docker Compose + reverse proxy + GitHub Actions | Portable SaaS/self-hosted; без Kubernetes на старте |

## Уточнения
- Для embed предпочтителен iframe: CSS изоляция и общий интерфейс; авторизацию проектировать без зависимости от third-party cookies. Не помещать долгоживущие токены в querystring.
- Для Telegram Mini App обязательно проверять signed initData на сервере, включая актуальность auth_date.
- Сайт, бот и AI используют один domain command API, не имеют собственных правил брони.
- Админку можно держать в том же SPA workspace или отдельной сборке; решение после UX-макетов.
- Не включать платежный процессинг, микросервисы, Redis, Kubernetes как обязательные зависимости для F1.

## Основания выбора — официальные документы
- Fastify plugins: https://fastify.dev/docs/latest/Reference/Plugins/
- Fastify validation: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- Drizzle Postgres: https://orm.drizzle.team/docs/get-started-postgresql
- Drizzle migrations: https://orm.drizzle.team/docs/migrations
- pg-boss: https://pgboss.io/introduction
- Telegram Mini Apps: https://core.telegram.org/bots/webapps

## Подготовить ADR
ADR-0002 Stack/versions, ADR-0003 Booking transaction, ADR-0004 Identity/Tenancy, ADR-0005 Shared booking UI/embed, ADR-0006 SaaS/self-hosted.
