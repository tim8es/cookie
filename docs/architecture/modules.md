# Модульность и контракты

**Статус: PROPOSED.** Это архитектурные границы, не реализация интерфейса.

## Определение модуля
Модуль — обособленный пакет с manifest (id, version, requires/provides capabilities, migrations), публичными портами (commands/queries/events) и private implementation. Может быть подключён на уровне deployment и доступен/недоступен конкретному tenant через entitlements.

## Жизненный цикл
Register -> validate dependency graph -> start -> ready -> stop. Без hot-load произвольного стороннего кода в F1/F2. Kernel не реализует учетные записи, данные и сервисные бизнес-операции.

## Установка кода, активация салона и разрешения пользователя
- Installed: проверенный модуль зарегистрирован при запуске приложения, общий процесс может обслуживать тысячи организаций. Модуль не означает выделенный контейнер или отдельную базу на каждого tenant.
- Enabled for tenant: platform-entitlements владеет конфигурацией подключённых возможностей, квотами и параметрами. Переключение действует во время работы SaaS и не требует перезапуска.
- Authorized for actor: включение модуля владельцем не даёт сотрудникам автоматически полный доступ. Каждая команда проходит RBAC/ABAC и tenant проверки.
- UI переключает видимость элементов, а API, workers, background handlers и AI tools независимо enforce доступ и ограничения. UI нельзя считать границей безопасности.
- Deploy новой версии модуля — управляемое обновление SaaS и self-hosted; это отдельно от переключения enabled.
- Произвольные сторонние модули, подгружаемые без deploy, не входят в F1/F2 до отдельного security ADR.

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

## Проектный принцип: модульность без перегрузки кабинета (ACCEPTED DEC-093 / REQ-057)
- Сохранять minimal kernel и модульный монолит с isolation/contracts для дальнейшего масштабирования. Архитектурная готовность к расширению **не означает обязательного выпуска всех возможностей в первом пилоте**.
- Для малого салона основной путь должен оставаться коротким: работа с услугами, графиками и подтверждёнными записями. Add-ons, дополнительные интеграции и расширенные настройки подключать и раскрывать постепенно, по готовности, спросу и entitlement.
- UI показывать только актуальные для пользователя возможности; API, jobs и AI tools независимо enforce tenant scopes и права доступа (согласуется с разделом «Установка кода, активация салона и разрешения пользователя»).
- Progressive UX/configuration — продуктовое требование, а детальный механизм feature flags/дистрибуции, отдельные deploy boundaries и лицензирование модулей пока PROPOSED. Не разворачивать отдельные сервисы ради формальной модульности.

## Первый пилот и необязательные модули (ACCEPTED DEC-095 / REQ-058)
- Пилот включает **не только web booking**: Telegram channel adapter и notification delivery — часть первого пользовательского продукта, при той же modular/platform архитектуре.
- **Bookings/Catalog/Scheduling/Identity** остаются source of truth и проверяют tenant, permissions и slot collisions. **Telegram** использует общие business commands через публичный API/ports, а **notifications** потребляют outbox/jobs после commit; retry/dedup не могут менять подтверждённый статус брони.
- **ACCEPTED DEC-097:** AI #31 точно не входит в первый пилот; карты #33 и остальные optional add-ons не входят автоматически. Не копировать бизнес-логику слотов внутрь Telegram и не вводить отдельный stateful booking engine для бота.
- **PROPOSED DEC-096:** сценарный Telegram UX, FAQ/handoff и набор уведомлений с явными шаблонами и состояниями доставки; архитектурные детали и критерии пилота согласовать с #29/#30 и #39.

## Telegram-бот без обязательной AI-зависимости (ACCEPTED DEC-097 / REQ-059)
- В пилоте **Telegram = сценарный channel adapter**; меню, callback/commands, FAQ и handoff работают без LLM, inference gateway, vector store или model provider. Кнопки и состояния бота не становятся отдельным источником истины для bookings.
- AI-консультант — **отдельный optional module после пилота** (#31), который в будущем может обращаться к тем же permission-checked commands и queries с отдельными entitlement, audit и подтверждениями. Отключенный AI не влияет на работу сценарного Telegram (#29), notification delivery (#30) и core booking.
- **PROPOSED DEC-098:** отдельный adapter API и модульная точка расширения. Избегать избыточной AI-инфраструктуры, пока сценарный пилот не покажет спрос.

## Channel layer
Чат-оркестратор использует общие business commands. Telegram, будущий VK/MAX/WhatsApp адаптируют форматы и доступные взаимодействия; идентичный внешний UX невозможен при разных API платформ. AI — optional interpreter, не owner записей.

## Решения до старта coding
Кто координирует transaction scheduling+booking; versioning manifest; стандарты errors/events; granularity policy, identity, tenancy; tenant segregation.
