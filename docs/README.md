# Карта документации и ревью

**Порядок чтения:** требования → пользовательские сценарии → архитектура → стек → безопасность/эксплуатация → roadmap → open decisions. Все документы написаны на русском. Нет производственного кода.

## Продукт
- [Видение](product/vision.md) (общий курс ACCEPTED).
- [PRD / требования, стадии F0–F3](product/requirements.md) (PROPOSED детализация).
- [Сценарии пользователей и UX-гипотезы](product/journeys.md) (PROPOSED).
- [Каталог продуктовых модулей](product/module-catalog.md) (PROPOSED).
- [Бизнес-модель и рынок](product/business-model.md) (RESEARCH).

## Архитектура
- [Обзор системы](architecture/system.md).
- [Каталог технических модулей, контракты](architecture/modules.md).
- [Данные и согласованность брони](architecture/data-and-booking.md).
- [Организации, филиалы, сотрудники, права — раунд 2](architecture/organization-location-and-access.md) (PROPOSED).
- [Предложенный технический стек](architecture/tech-stack.md).
- [ADR-0001 minimal kernel](architecture/ADR-0001-plugin-kernel.md).
- [ADR-0002 stack](architecture/ADR-0002-technical-stack.md).
- [ADR-0003 atomic booking](architecture/ADR-0003-booking-consistency.md).
- [ADR-0004 identity/tenancy](architecture/ADR-0004-identity-tenancy.md).
- [ADR-0005 UI/embedded widget](architecture/ADR-0005-shared-booking-ui.md).
- [ADR-0006 SaaS/self-hosted](architecture/ADR-0006-distribution.md).
- [ADR-0007 AI/channel safety](architecture/ADR-0007-channel-ai-command-safety.md).

## Эксплуатация, качество и планирование
- [Security и ПДн](operations/security-and-privacy.md).
- [Развёртывание и лицензирование](operations/deployment.md).
- [Тестовая стратегия](quality/test-strategy.md).
- [Дорожная карта](delivery/roadmap.md).
- [Индекс Issues](delivery/backlog-index.md).
- [Процесс разработки, критерии готовности](delivery/workflow.md).
- [Реестр рисков](delivery/risk-register.md).
- [Реестр решений](decisions/register.md).
- [Архитектурное ревью: раунд 1](decisions/architecture-review-round-1.md) — вопросы владельцу до принятия ключевых ADR.

- [Доменные контракты Booking, Staff, Entitlements и AuthZ](architecture/f0-contracts-and-invariants.md).
- [Сценарии тестирования F1 и пилота (41)](quality/f1-pilot-acceptance-cases.md).
- [Операционный runbook и pre-real-pilot gate](operations/pilot-operational-readiness.md).
- [Конкурентное исследование и unit economics](product/market-economics-validation.md).
- [Краткий итог F0 и критерии owner sign-off](delivery/f0-closure-review-20261114.md).
## Единый пакет на ревью F0 (предложения, не подтверждение владельца)

- [Краткий пакет решений F0-P01..P12](decisions/f0-owner-review-package-20261114.md) — приоритетный документ для владельца.
- [Технический blueprint](architecture/f0-implementation-blueprint.md) — runtime, API, транзакции, доступы, UX screen map и порядок F1.
- [Traceability REQ-001–067 → проверяемый смысл/фаза/Issue](delivery/requirements-traceability-f0.md).
- [Коммерческий playbook и шаблон индивидуального предложения](product/pilot-commercial-playbook.md).
- [F0 consistency audit с P0 блокерами](delivery/f0-consistency-audit-20261114.md).

**Порядок:** владелец проверяет пакет один раз, вносит существенные замечания, автор применяет их в ADR/issues и только после отдельного утверждения решается F0 Gate. Не превращать выбор каждого библиотечного пакета в новый продуктовый вопрос.

## Правила статусов
- **ACCEPTED:** подтверждено в обсуждении; нельзя молча менять.
- **PROPOSED:** разработанная рекомендация, нужна проверка и утверждение.
- **RESEARCH:** существенная неизвестность; не обещать клиентам.
- **DEFERRED:** идея без обязательств первого релиза.

## F0 Gate
Открытые задачи **#8–#14** должны быть просмотрены владельцем до [решения по F0 Gate в #15](https://github.com/tim8es/cookie/issues/15). Финальный аудит текущего baseline: [F0 consistency audit, 2026-11-14](delivery/f0-consistency-audit-20261114.md). Технические решения не зафиксированы окончательно только потому, что уже оформлены в ADR с PROPOSED. PR документации — точка review, merge и явное разрешение начать F1 обязательны.
