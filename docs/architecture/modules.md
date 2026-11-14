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

## Post-trial ограничение создания броней (ACCEPTED DEC-105 / REQ-063)
- По окончании 30-дневного trial без платной лицензии **CreateBooking недоступен для Organization через все каналы**: public web, Telegram, admin, API. Channel adapters не вправе создавать локальный bypass к central entitlements. Фактическая проверка на сервере не сводится к скрытию кнопки.
- **Независимые права:** чтение/обслуживание ранее Confirmed, разрешённый RescheduleBooking только по времени, CancelBooking и экспорт данных должны сохраняться без оплаты; прежние правила actor/tenant/RBAC/ABAC обязательны. Ошибка notification provider не меняет Booking; policy изменения не ретроактивно пересчитывают записи.
- **PROPOSED DEC-106:** domain-level policy on CreateBooking, статус trial_expired/paid_active, check at commit, audit, idempotency and race handling, channel UX and future reactivation; detailed access matrix/data retention on review. Не закладывать «вечный Free booking» как дефолтную entitlement.

## Коммерческий tier по числу мастеров (ACCEPTED DEC-107 / REQ-064)
- **Продуктовое правило:** уровни платной подписки отличаются количеством учитываемых мастеров; **число создаваемых Booking внутри оплаченного уровня не ограничено коммерческой квотой**. Сайт, Telegram и Business Workspace читают единый tenant-scoped entitlement; не создавать самостоятельную подсистему квот на Booking по каналам.
- Не путать коммерческие квоты с защитными техническими rate limits, антиспамом, проверкой занятости или permissions — они сохраняются. **PROPOSED DEC-108:** проверять вместимость tier на сервере и безопасно обрабатывать изменение числа учитываемых мастеров, renewal/upgrade/downgrade.
- **ACCEPTED DEC-109:** уникальные действующие мастера, доступные для записи, один раз по Organization; архивные и администраторы без услуг исключены. **OPEN:** отпуск/временная недоступность и технический критерий active & bookable, а также превышение tier Q45.

## Учёт уникальных bookable мастеров в тарифе (ACCEPTED DEC-109 / REQ-065)
- Оплачиваемая вместимость tier основана на **уникальных действующих Staff, доступных для записи в Organization**. Multi-location master не умножает количество billable seats; администраторы без услуг и архивные мастера исключены. Совмещение admin+bookable master не освобождает от учёта мастера.
- **PROPOSED DEC-110:** расчёт по стабильным staff ID и факту active & bookable хотя бы в одной Location, не по location assignment, user membership или имени. Работает как центральное server-side entitlement, а не frontend-only/канальный подсчёт; IDOR/tenant isolation, audit и реакция на изменения.
- **OPEN:** правила временной недоступности, отсутствия слотов/отпуска; нельзя автоматически приравнять отпуск к архивному мастеру. **DEC-111 Q45 ACCEPTED:** сверхлимитный мастер может быть добавлен в справочник, но активация только после добровольного upgrade; downgrade детали на review.

## Превышение tier при активации мастера (ACCEPTED DEC-111 / REQ-066)
- Модуль Staff/Catalog разрешает **создать и сохранить профиль** нового мастера даже при полном paid tier. Но операция, делающая его действующим и доступным клиентской записи, должна через Subscription/Entitlements убедиться, что уникальный billable count по DEC-109/REQ-065 не превысит вместимость tier.
- **ACCEPTED:** при превышении отказать в активации нового мастера без изменения текущих действующих мастеров, календарей и Confirmed Booking. Предложить отдельный, **добровольный upgrade**. Ни создание профиля, ни проба активации не инициируют списание/автоматический upgrade.
- **PROPOSED DEC-112:** разделить draft profile vs active bookable, enforce при activation/publish/StaffLocationAssignment/import/API, транзакционная проверка/конкурентные активации/idempotency, audit и корректное сообщение. Не переносить коммерческую логику в minimal kernel; временные статусы/нештатный downgrade/платёжный контракт на review.

## Channel layer
Чат-оркестратор использует общие business commands. Telegram, будущий VK/MAX/WhatsApp адаптируют форматы и доступные взаимодействия; идентичный внешний UX невозможен при разных API платформ. AI — optional interpreter, не owner записей.

## Решения до старта coding
Кто координирует transaction scheduling+booking; versioning manifest; стандарты errors/events; granularity policy, identity, tenancy; tenant segregation.

## F0 blueprint — рекомендуемые модули (PROPOSED)
Разделить minimal kernel (registry/lifecycle/contracts) от platform (Identity/Tenant/Policy/Persistence/Entitlements/Jobs) и domain (Organization/Catalog/Staff/Scheduling/Customer/Booking/Pricing). Channel adapters (Svelte shells/Telegram) не имеют своей Booking database. Новая Booking разрешается только tenant entitlement; existing Confirmed можно управлять и экспортировать после unpaid trial. [Blueprint](f0-implementation-blueprint.md) и [решения для одного review](../decisions/f0-owner-review-package-20261114.md); конкретные порты/проверки на engineering review F1.
