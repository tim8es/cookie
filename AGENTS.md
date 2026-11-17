# Cookie: инструкция для Codex и других агентов

## Owner target update — 2026-11-16: real application, local + Altare staging

**New acceptance target:** [Release issue #203](https://github.com/tim8es/cookie/issues/203). The deliverable is a production-shaped **real runtime**, not mock-onboarding screenshots or a synthetic Booking API proof. Keep the current F1 security restrictions until their own gates pass.

- **Implement genuine end-to-end flows:** first-run real authenticated owner/Organization/Location; persistent Services/Staff/Schedules; server-authoritative availability and Booking Create/Cancel/Reschedule; a real owner Calendar; mobile web uses the same backed API. Ordinary execution must never silently fall back to `sessionStorage` or a mock provider. Pure mock fixtures remain opt-in for isolated UI tests.
- **Test two actual deployments:** reproducible clean local start and isolated Altare staging, with explicit PostgreSQL migrations, durable persistence after restart, startup/health, logs, backed-up data and verified restore. The same built application/runtime contracts must behave consistently.
- **Do not expose synthetic F1 inject-only HTTP adapters** by wiring fake session-verifier/entitlement callbacks into `apps/api/src/main.ts`. Complete real AuthN/tenant/customer ownership and concurrency fixes #113/#165 before any public Booking API. `#175` strict Workspace-read policy requires separate approved resolution.
- **Altare platform facts:** Sandboxes and Go cannot run Docker-in-Docker; use App Hosting (Node 26; managed PostgreSQL **17** requires extra integration proof), or a full Workstation supporting Docker with PostgreSQL 16. Do not promise an untested platform, persistent worker, TLS domain or backup.
- **No mock = no false success:** document blocked steps as blocked and record CI SHA, Postgres version, actual DB/HTTP/browser traces, and deployment evidence. A green synthetic Chromium screenshot alone is not pilot readiness.
- **Scope of this authorization:** code, builds and real-mode **local / private controlled staging** can proceed with generated synthetic test accounts and records. The owner has **not** separately approved real customer PII, public commercial pilot, production rollout or real payments. Preserve legal, security, localization and restore gates (#37/#38) until explicitly passed.

For agents running in parallel, coordinate by #203 and existing Issues (#23 real E2E, #66 UI transport, #36 deployment, #113/#165 security). Do not duplicate owners' active PRs; deliver bounded tested changes and independent reviews.


## Текущий режим — F0 APPROVED, F1 ENGINEERING AUTHORIZED (2026-11-14)
Владелец явно **утвердил F0-P01–F0-P12** и отдельно разрешил **F1: инженерный bootstrap, CI, PostgreSQL и основу приложения**.
- Разрешено: в отдельной feature-ветке и отдельном PR писать приложение, миграции, CI, тесты, Docker Compose только для локальной/CI разработки с **синтетическими данными**.
- Сначала оформить и проверить F0 PR #43; F1 PR делать **stacked на F0-ветку** до слияния F0, не коммитить F1 напрямую в main.
- **Запрещено без отдельного согласия:** реальный коммерческий пилот, работа с реальными ПДн, платежи/автосписания, production deployment, подключение платных провайдеров/реальных каналов.
- Только проверенные CI/test evidence позволяют маркировать инженерное acceptance выполненным. Любое новое спорное коммерческое/правовое/безопасностное решение выносить на review, технические детали внутри baseline выполнять самостоятельно.
- Фактический F0 approval **не означает**, что SQL/конкурентные тесты, legal/ПДн, performance/backup и рыночная конверсия выполнены.

## Source of truth
- Старт: docs/README.md.
- Product requirements: docs/product/requirements.md (REQ IDs).
- Roadmap: docs/delivery/roadmap.md.
- Решения: docs/decisions/register.md и ADR.
- Задачи: GitHub Issues с P0/P1/P2 и F0/F1/F2/F3 в названии/теле.

## Работа с изменениями
1. Перед задачей прочитать соответствующий REQ, ADR, Issue и зависимости.
2. Поддерживать единый терминологический словарь (kernel, platform, business module, addon, adapter, tenant).
3. Не переносить business logic в minimal kernel.
4. При противоречии спросить владельца через Issue/PR обсуждение, не молча решать за него.
5. Документировать ACCEPTED/PROPOSED/RESEARCH/DEFERRED.
6. Создавать отдельную ветку и PR, не пушить напрямую в main.
7. В PR ссылаться на Issue, перечислять внесённые изменения, риски и открытые решения.
8. Не добавлять секреты, реальные ПДн, клиентские переписки или чужой проприетарный код.

## После F0 approval — F1 implementation, явно разрешено 2026-11-14
- Сначала создать/проверить tooling по #16, затем kernel/port contracts; тесты обязательны.
- Не использовать внешний AI/канал как источник прав и истины о брони.
- Проверять границы модулей, idempotency, transactions, tenant isolation и backward compatibility.
- Не включать платные модули в kernel, не разворачивать микросервисы без принятого ADR.
