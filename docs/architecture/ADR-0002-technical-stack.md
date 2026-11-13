# ADR-0002 — Базовый стек и границы monorepo

**Статус: PROPOSED** · Решить в Issue #10 · Зависит от #9.

## Предлагаемое решение
TypeScript + поддерживаемый Node.js LTS; pnpm workspaces; Fastify как HTTP adapter; pure TS plugin host; PostgreSQL; Drizzle + SQL migrations; React/Vite для web; API REST/OpenAPI; Postgres-based jobs/outbox; Vitest/Playwright/integration Postgres; Docker Compose + GitHub Actions.

## Почему
Мало языков и инфраструктурных компонентов, одна команда разработки и агентные инструменты, DB-atomic booking, репозиторий с versioned shared contracts, готовность к self-hosted. Framework Fastify обеспечивает HTTP plugins, но **не является** архитектурным plugin kernel.

## Альтернативы
NestJS (организация DI, но дополнительная структура, риск «большого приложения»); Next.js (SSR и SEO, но сложнее multi-surface embed; вернуться при потребности публичного SEO); Kysely vs Drizzle (сравнить type safety/migrations); Redis queue vs Postgres queue (отдельный сервис без доказанной нагрузки).

## Последствия
Зафиксировать версии при implementation bootstrap; build pipeline проверяет публичные контракты; SQL critical booking пишется/ревьюится явно. Выбор libraries не может нарушать modular boundary.

## Нерешённые вопросы
Проверка package/Node versions, выбор Telegram SDK, виджет iframe vs custom elements, Caddy/Traefik для self-hosted, job queue idempotency. Проверить актуальные официальные docs перед фиксацией.

## Критерии принятия
Имеется сравнение альтернатив/операционной сложности, репозиторная структура согласована, не требуется infrastructure Kubernetes/Redis для F1.
