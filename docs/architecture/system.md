# Архитектура системы

**Статус: PROPOSED.** Принцип минимального kernel и модульного монолита согласован, технические детали — на ревью.

## Контекст
Цели: SaaS для нескольких организаций и отдельные self-hosted установки без форков; добавление модулей без изменения ядра; масштабирование нагрузки; независимость бизнес-правил от Telegram, AI и конкретного облака.

~~~mermaid
flowchart TB
  Client["Клиент: браузер / Mini App"]
  Biz["Сотрудник / владелец"]
  Bot["Telegram / другие каналы"]
  Web["Booking UI + Business UI"]
  Http["HTTP / Chat adapters"]
  Kernel["Minimal Plugin Kernel"]
  Platform["Platform modules: identity, tenancy, persistence, jobs"]
  Domain["Domain modules: booking, scheduling, catalog, staff, customers"]
  Extra["Extensions: AI, approvals, maps, MCP"]
  DB["PostgreSQL / Outbox / Jobs"]
  External["Внешние API"]
  Client --> Web
  Biz --> Web
  Bot --> Http
  Web --> Http
  Http --> Kernel
  Kernel --> Platform
  Kernel --> Domain
  Kernel --> Extra
  Platform --> DB
  Domain --> DB
  Extra --> External
~~~

Стрелки — логическое взаимодействие, не разрешение прямых импортов и чужих SQL-таблиц.

## Границы
- Kernel: реестр модулей/capabilities, dependency graph, lifecycle, контекст выполнения, hooks. Без сущностей салона, клиента, записи.
- Platform: identity, policy, tenants, persistence, jobs/outbox, telemetry, entitlements.
- Domain: организации, каталог, staff, графики, бронь, клиенты, уведомления, visits.
- Adapters: HTTP API (Fastify при Node.js; stdlib/chi при Go), Telegram, web-widget, AI-tool, карты, будущий MCP. Domain и kernel не зависят от выбранного HTTP runtime.
- Один backend runtime/API process и один Postgres в MVP; фоновые workers можно выделить отдельно. Статические web-ресурсы по возможности обслуживаются без отдельного Node SSR runtime; выбор зависит от ADR-0002/ADR-0005. Микросервисов в F1 нет.
- Каждый бизнес-модуль имеет публичный контракт, принадлежащие ему таблицы/миграции. Синхронные инварианты защищаются транзакциями; побочные эффекты — outbox/events.
- Конечный бизнес-модуль не зависит от UI, Telegram и AI.

## SaaS vs self-hosted
Одинаковые пакеты и версии. В SaaS каждый запрос несёт tenantId и identity; в self-hosted одна изолированная инсталляция может использовать тот же механизм. Функциональные лицензии/entitlements — platform-модуль, не ядро.

## Масштабирование
Сначала метрики RPS, p95 latency, conflict rate, job lag, Postgres connections, DB size; масштабировать stateless API/worker и DB. Отделять микросервис при наблюдаемом независимом bottleneck или необходимости отдельных релизов, с ADR и планом migratе/rollback.

## Гейты
Работа без add-on; отсутствие прямых импортов; конкурентная бронь; tenant/policy isolation; восстановление backup; деградация при отказе Telegram/AI. Детали — отдельные документы.
