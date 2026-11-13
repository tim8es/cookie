# Модульность и контракты

**Статус: PROPOSED.** Это архитектурные границы, не реализация интерфейса.

## Определение модуля
Модуль — обособленный пакет с manifest (id, version, requires/provides capabilities, migrations), публичными портами (commands/queries/events) и private implementation. Может быть подключён на уровне deployment и доступен/недоступен конкретному tenant через entitlements.

## Жизненный цикл
Register -> validate dependency graph -> start -> ready -> stop. Без hot-load произвольного стороннего кода в F1/F2. Kernel не реализует учетные записи, данные и сервисные бизнес-операции.

## Зависимости
| Provider | Consumer | Capability |
|---|---|---|
| identity/policy | API, staff, booking, AI, MCP | actor auth, permissions |
| organization | staff, schedule, catalog | business timezone/settings |
| catalog | bookings, AI, UI | service & price/quote |
| staff | scheduling, booking UI | staff/qualifications |
| scheduling | bookings, approval | availability & change |
| customers | bookings, notifications | customer reference, contact policy |
| bookings | UI, bot, AI, reports | create, reschedule, cancel |
| jobs/outbox | notifications/integrations | retry, delivery |
| entitlements | API/add-ons | module enablement/limits |

## Правила
1. Прямые imports internal-классов или чужих таблиц запрещены. Только опубликованные версии контрактов.
2. Вызов изменяющей команды требует actor, tenant, idempotency key, корреляции, проверки разрешений.
3. Циклические обязательные зависимости запрещены.
4. Синхронные гарантии бронирования не подменять eventual-consistency events.
5. У каждого модуля — собственные таблицы и миграции. Транзакционную координацию между доменными границами уточнить отдельным ADR.
6. Ошибка optional модуля не должна блокировать запись.
7. Отдельная поддержка старых self-hosted версий требует политики совместимости контрактов и миграций.
8. Переход от local ports к remote RPC потребует пересмотра отказоустойчивости, транзакций и безопасности; сделать архитектурный spike.

## Channel layer
Чат-оркестратор использует общие business commands. Telegram, будущий VK/MAX/WhatsApp адаптируют форматы и доступные взаимодействия; идентичный внешний UX невозможен при разных API платформ. AI — optional interpreter, не owner записей.

## Решения до старта coding
Кто координирует transaction scheduling+booking; versioning manifest; стандарты errors/events; granularity policy, identity, tenancy; tenant segregation.
