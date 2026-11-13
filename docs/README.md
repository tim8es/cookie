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

## Правила статусов
- **ACCEPTED:** подтверждено в обсуждении; нельзя молча менять.
- **PROPOSED:** разработанная рекомендация, нужна проверка и утверждение.
- **RESEARCH:** существенная неизвестность; не обещать клиентам.
- **DEFERRED:** идея без обязательств первого релиза.

## F0 Gate
Открытые задачи [#8–#15](https://github.com/tim8es/cookie/issues/1) должны быть просмотрены владельцем. Технические решения не зафиксированы окончательно только потому, что уже оформлены в ADR с PROPOSED. PR документации — точка review, merge и явное разрешение начать F1 обязательны.
