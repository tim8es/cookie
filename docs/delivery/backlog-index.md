# Индекс задач / кросс-ссылки

**Единый backlog — [GitHub Issues](https://github.com/tim8es/cookie/issues).** Данный файл навигационный, не независимое состояние задач. Состояния/закрытия актуальны только в GitHub.

## Эпики
- [#1 F0 Документация](https://github.com/tim8es/cookie/issues/1) — P0: review до разработки.
- [#2 F1 Kernel/platform](https://github.com/tim8es/cookie/issues/2) — P0.
- [#3 F1 Booking vertical](https://github.com/tim8es/cookie/issues/3) — P0.
- [#4 F2 UX/client/business](https://github.com/tim8es/cookie/issues/4) — P1.
- [#5 F2 Автоматизация и расширения](https://github.com/tim8es/cookie/issues/5) — P1.
- [#6 F2 Поставка, безопасность, продажи](https://github.com/tim8es/cookie/issues/6) — P0/P1.
- [#7 F3 Будущие модули](https://github.com/tim8es/cookie/issues/7) — P2.

## F0 — готовим и утверждаем документы
| Issue | Область | Статус |
|---|---|---|
| #8 | PRD/scope F1–F3 | draft docs, awaiting review |
| #9 | kernel/module ADR | awaiting review |
| #10 | ADR-0002 стек | awaiting review |
| #11 | ADR-0003 booking | awaiting review |
| #12 | ADR-0004 identity, tenants, ПДн | awaiting review |
| #13 | ADR-0005 UX/embed | awaiting review |
| #14 | конкуренты, unit economics, лицензии | research |
| #15 | consistency audit & explicit owner approval | blocked by #8–#14 |

## F1 — после F0 Gate
| Issue | Задача |
|---|---|
| #16 | Bootstrap/CI |
| #17 | Kernel runtime |
| #18 | Identity/Tenant/Policy |
| #19 | Persistence/outbox/jobs |
| #20 | Catalog/Staff/Scheduling |
| #21 | Atomic Booking |
| #22 | Booking API/contracts |
| #23 | Technical UI/calendars |

## F2 — коммерческая версия
| Issue | Задача |
|---|---|
| #24 | Shared web/widget/Mini App |
| #25 | Profile/repeat/reschedule/cancel |
| #26 | Business workspace |
| #27 | Themes/onboarding |
| #28 | Analytics/simple promotions |
| #29 | Telegram bot |
| #30 | Notifications/jobs |
| #31 | AI assistant |
| #32 | Staff schedule approvals |
| #33 | Yandex/2GIS feasibility/adapters |
| #34 | Staff/admin chat commands |
| #35 | Tenant entitlements / SaaS |
| #36 | Docker self-hosted |
| #37 | Security/privacy/RF |
| #38 | Monitoring/backup/recovery |
| #39 | Commercial pilots/pricing |

## F3 — после подтверждения необходимости
#40 MCP; #41 voice/new messenger channels; #42 loyalty/finance/stock modules.

## Как читать
В каждой задаче указаны parent epic, P0–P2, F0–F3, ссылки на REQ/документы, dependencies и checklist приёмки. Изменения Issue требуют синхронизации roadmap и PRD, если меняется содержание продуктового релиза.
