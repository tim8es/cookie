# Продуктовый каталог модулей

**Статус:** направления зафиксированы, границы и упаковка предварительные. **Не путать** модуль кода, включённую функциональность клиента и тариф.

| Product module | Ценность | Обязательные capabilities | Фаза |
|---|---|---|---|
| Catalog | Общий каталог Service, базовые цены и F2-переопределения по филиалу и мастеру в филиале | Organizations, Locations, Staff, persistence | F1/F2 |
| Staff | Сотрудники, единый профиль мастера и назначения в несколько филиалов (F2), доступы | Identity, organizations, Locations | F1/F2 |
| Scheduling | Графики и доступность | Staff, organization-timezone | F1 |
| Booking | Создать, изменить и отменить бронь | Catalog, Scheduling, Customers | F1 |
| Client Booking UI | Страница, widget, Mini App | Booking read/write API | F1/F2 |
| Business Workspace | Управление и календарь | Business modules, permissions | F1/F2 |
| Telegram Channel | Меню, FAQ, уведомления, handoff администратору | Identity/linking, Booking API, Jobs | F2 |
| Notifications | Напоминания, шаблоны, доставка | Events, Jobs, Providers | F2 |
| Configurable Discounts & Promotions | Настраиваемое совместное применение автоматических скидок и промокодов | Catalog pricing/Quote, Booking, policy, audit | F2, обязательная продуктовая возможность; детали расчёта на ревью |
| Basic Analytics | Достоверные отчёты | Booking/Visit events | F2 |
| Related-service recommendations | Настраиваемые предложения услуг без составных броней | Catalog, Booking read/start flow, Entitlements | F2 add-on, proposed |
| AI Assistant | Диалог и безопасные tool calls | Channel, Booking APIs, policy | F2 add-on |
| Staff Schedule Approval | Базовый процесс запросов и одобрений при выбранном владельцем режиме | Scheduling, policy, notifications | F2 обязательный модуль/возможность; расширенные workflow add-on позже |
| Maps: Yandex/2GIS | Кнопки/ссылки онлайн-записи | Public booking URL, partner API access | F2 add-on/RESEARCH |
| Loyalty Pro | Баллы, сертификаты, абонементы | Customers, Quotes, settlement | F3 |
| Voice | Команды голосом | Channel adapter, transcription, policy | F3 |
| MCP | Внешние агенты | Identity, authz, domain capabilities | F3 |
| SaaS Subscription / Entitlements | 30-дневный trial при регистрации, индивидуальный предварительный оффер, post-trial no-new-bookings, платные tiers по уникальным действующим bookable мастерам, добровольный upgrade без квоты бронирований | Organization/Identity/Staff, Booking API policy, consent/audit, paid provider | F2 pilot-critical, product rules ACCEPTED DEC-099/101/103/105/107/109/111/113, implementation PROPOSED |
| Finance/Payroll/Stock | Финансы и склад | Visits/Products/Payments | F3 |

## Правила комплектации
- F1/F2 — инженерные фазы, не названия коммерческих тарифов.
- Базовые модули создают работающий продукт; add-on-модули отключаемы по организации и не должны разрушать booking.
- Для self-hosted предоставляется совместимый образ + manifest разрешённых модулей; для SaaS общая система с tenant entitlements.
- Нельзя обещать feature карты до проверки допустимого подключения; fallback — прямая ссылка/инструкция.
- AI может отвечать за рекомендации и запрос намерения, но не выступает источником правды о доступных слотах.

## Data Exchange и Telegram Admin (DEC-116)
| Product capability | Ценность | Зависимости | Фаза |
|---|---|---|---|
| Data Exchange | Табличный onboarding, периодическое обновление и экспорт | Catalog/Staff/Scheduling, Organization, Booking/Visit read, Identity/Policy, Entitlements, Jobs/Audit | F2 early #252 |
| Telegram Admin | Лёгкий рабочий кабинет и файловый обмен через существующего бота | Data Exchange, Telegram adapter, shared UI, Business Workspace API, Policy | F2 #253 |
| Sheets/Scheduled connector | Автоматизация обмена при подтверждённом спросе | Data Exchange и отдельные reviewed sync contracts | F3 #254 PROPOSED |

Data Exchange не является хранилищем доменных данных; наличие админского Telegram-режима не делает AI обязательным. Тарифная упаковка отдельно; [спецификация](tabular-and-telegram-admin.md).
