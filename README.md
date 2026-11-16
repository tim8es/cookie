# Cookie / Kuki — рабочее название

Платформа онлайн-записи и автоматизации малого сервисного бизнеса. На старте — салоны с 2–10 специалистами.

**Статус 2026-11-14:** F0 архитектура утверждена владельцем (DEC-115), разрешена F1 инженерная разработка (bootstrap, CI, PostgreSQL, приложение) через отдельные PR. Коммерческий пилот, продакшен-деплой, реальные ПДн и автоматические платежи не разрешены.

## Статус решений
- **ACCEPTED:** минимальное техническое ядро + самостоятельные модули, модульный монолит/монорепозиторий, единый Booking UI (web/embed/Telegram Mini App), SaaS и self-hosted, фокус на небольших салонах.
- **PROPOSED:** конкретные технологии, схемы данных/прав, детали модульных контрактов, интерфейсы, deployment.
- **RESEARCH:** цены, подтверждённый спрос, условия интеграций карт, юридическая модель, конкретный hosting.

- [Доменные контракты и инварианты бронирования/тарифов/AuthZ](docs/architecture/f0-contracts-and-invariants.md).
- [Каталог 41 приёмочного сценария для F1/пилота](docs/quality/f1-pilot-acceptance-cases.md).
- [Операционная готовность / runbooks / защита ПДн](docs/operations/pilot-operational-readiness.md).
- [Рыночная матрица и модель unit economics](docs/product/market-economics-validation.md).
- [Итоговый F0 owner review / evidence gate](docs/delivery/f0-closure-review-20261114.md).
## Архивный пакет F0 — утверждён владельцем (DEC-115)

- [Рекомендуемые решения — единый пакет F0-P01..P12](docs/decisions/f0-owner-review-package-20261114.md).
- [Implementation blueprint: стек, границы, Booking, authZ, screen map](docs/architecture/f0-implementation-blueprint.md).
- [Traceability REQ-001–067](docs/delivery/requirements-traceability-f0.md).
- [Коммерческий playbook первых салонов](docs/product/pilot-commercial-playbook.md).
- [Итог документального аудита и блокеры F0 Gate](docs/delivery/f0-consistency-audit-20261114.md).

Материалы были подготовлены как **PROPOSED** для review 2026-11-14. Позже в тот же день владелец явно принял F0-P01–F0-P12 (DEC-115) и разрешил F1 engineering. Документационный [PR #43](https://github.com/tim8es/cookie/pull/43) уже объединён с `main`. При этом отдельные детали реализации сохраняют статус PROPOSED там, где он указан в реестре; пилот, реальные ПДн, платежи и production deployment **не разрешены**.

## Начать чтение
1. [Карта всей документации](docs/README.md).
2. [Продуктовое видение](docs/product/vision.md).
3. [PRD и требования](docs/product/requirements.md).
4. [Архитектура системы](docs/architecture/system.md) и [модули](docs/architecture/modules.md).
5. [Предложение по стеку](docs/architecture/tech-stack.md).
6. [Реестр решений](docs/decisions/register.md).
7. [Дорожная карта](docs/delivery/roadmap.md) и [индекс задач](docs/delivery/backlog-index.md).
8. [GitHub Issues](https://github.com/tim8es/cookie/issues).

## Принципы
- Kernel ничего не знает о бронировании, салонах, клиентах или финансовых операциях.
- Business logic — в domain modules с публичными контрактами; каналы/AI/карты независимы.
- Все точки записи используют один атомарный Booking API.
- Должны существовать SaaS и self-hosted версии без forks.
- Не обещаем AI, внешние интеграции или privacy без проверки экономики, прав и технической реализуемости.
- Не используем реальные ПДн в демонстрационных внешних средах без надлежащего правового основания.

## Разработка
**F1 инженерная разработка разрешена** с 2026-11-14 (DEC-115): приложение, миграции, CI и тесты на синтетических данных в отдельных feature-ветках через PR. Не пушить напрямую в `main`; перед объединением проверять зависимости stacked PR и результат CI на точном commit SHA. [AGENTS.md](AGENTS.md) и [правила работы](docs/delivery/workflow.md) описывают workflow.

**F1 не является разрешением на коммерческое использование.** Для реальных клиентов, ПДн, платежей, платных провайдеров, production deployment требуется отдельное согласование. Текущие блокирующие задачи: [#113](https://github.com/tim8es/cookie/issues/113) — синхронизация прав с Booking, [#66](https://github.com/tim8es/cookie/issues/66) — web/API контракты и интеграция, [#23](https://github.com/tim8es/cookie/issues/23) — настоящий технический E2E. Успешный CI отдельного Draft PR не означает завершённый Pilot Gate.

Название продукта пока не утверждено; репозиторий остаётся приватным.
