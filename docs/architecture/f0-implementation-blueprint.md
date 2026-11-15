# Cookie — рекомендуемый implementation blueprint для F1 и первого пилота

**Статус: PROPOSED для единого owner-review.** Это не согласованный стек, не результат тестирования кода и не команда на разработку. [Пакет решений F0-P01..P12](../decisions/f0-owner-review-package-20261114.md); [исходные ADR](ADR-0001-plugin-kernel.md) / [ADR-0002](ADR-0002-technical-stack.md) / [ADR-0003](ADR-0003-booking-consistency.md) / [ADR-0004](ADR-0004-identity-tenancy.md) / [ADR-0005](ADR-0005-shared-booking-ui.md).

## 1. Состав и deployment

```text
browser / embed iframe / Telegram bot or Mini App
    └── channel shell + shared Booking UI (Svelte 5, static)
          └── HTTPS JSON/OpenAPI → Fastify API (Node 26 LTS / TypeScript)
                ├── platform: Identity, Tenancy, Policy, Entitlements
                ├── domain: Organization, Catalog, Staff, Scheduling, Customers, Booking, PriceQuote
                ├── transport adapters: web, Telegram, notification providers
                ├── contracts / minimal module kernel
                └── PostgreSQL (transactional Booking + outbox + jobs)
                                   └── worker process (same application release)
```

**F1:** отдельные API и worker процессы одного versioned release + static UI. Один PostgreSQL для разработки/test/prod в рамках соответствующей среды (не общий dataset). Не добавлять Redis, Kafka, API gateway/Service Mesh/Kubernetes, отдельные tenant DB и hot plugins без метрик или реальной потребности. Self-hosted позже упаковать в Docker Compose; multi-tenant SaaS — один общий runtime с обязательным tenant isolation.

**Предложенный repo layout (без создания code сейчас):**
```text
apps/api                   Fastify transport, composition root
apps/worker                outbox and reminders
apps/web                   shared Svelte 5 + Vite app, shells
packages/contracts         versioned JSON Schema / OpenAPI / domain contracts
packages/kernel            registry, lifecycle, scoped request context
packages/platform/*        identity, tenancy, authz, entitlements, jobs
packages/domain/*          catalog, staff, scheduling, customer, booking, pricing
packages/adapters/*        telegram, notification providers, external interfaces
packages/testing           contract fixtures, Postgres race harness
db/migrations              versioned SQL, destructive migration guards
docs                        project ADR, requirements, runbooks
```

**Monorepo candidate:** pnpm workspace для TypeScript packages, один lockfile. API/worker используют чёткие domain ports. Domain не импортирует Fastify/Svelte/Telegram и не знает о тарифах или внешнем billing provider кроме `Policy.canCreateBooking`/capability. F0-P04 исключает «большое ядро» с бизнес-сущностями.

## 2. API, безопасность и контракты

### Command/query boundaries
| Команда/запрос | Вход | Обязательная server-side проверка | Выход/ошибка |
|---|---|---|---|
| `QueryServices`, `QueryAvailability` | tenantPublicRef, locationId?, serviceId, staffId?, date | service active, location visibility, timezone, public rate limit; public DTO без секретов | список вариантов, срок действия не гарантирован |
| `CreateBooking` | serviceId, locationId, staffId, start, contact identity, Idempotency-Key, quoteVersion | trust actor/guest scope, tenant, entitlements active or trial, service+staff+schedule, price, range conflict | Confirmed Booking snapshot или 409/422/403 |
| `RescheduleBooking` | bookingId, new start, version/key | actor permission/guest proof, cutoff, staff/location unchanged, new slot & invariant, paid rule **не блокирует** time-only reschedule existing Booking | прежняя Confirmed при ошибке |
| `CancelBooking` | bookingId, version/key | actor permission, cutoff, tenant, existing state | Cancelled + outbox, immutable audit |
| `CreateStaffProfile` | staff data | org scoped create permission; **не проверять paid capacity на сохранение профиля** | saved draft/nonbookable |
| `PublishStaffForBooking` | staffId, location/service assignments, version/key | active paid tier + unique billable staff capacity, permission, multi-location identity, race guard | published or capacity conflict; не изменяет уже Confirmed |
| `ExportOrganizationData` | organizationId, actor | owner/specific explicit permission, tenant, audit, rate controls; доступен и после trial expiry | безопасный scoped export/receipt |
| `StartPaidEntitlement` | offer version, explicit consent, payment evidence | privileged owner, verified offer, confirmed payment/contract, no silent opt-in | paid tier entitlement, audit |

Чтение availability **не резервирует** время. Успех `CreateBooking` показывается только после successful DB commit. API должен возвращать канонические ошибки типа `BOOKING_CONFLICT`, `TRIAL_EXPIRED`, `STAFF_TIER_FULL`, `BOOKING_NOT_MANAGEABLE` и `AUTH_SCOPE_DENIED`; конкретные коды/HTTP mapping и поля PROPOSED. Не дублировать отдельные доменные операции в Telegram.

### Минимальная матрица разрешений (PROPOSED, не окончательная юридическая матрица)

| Действие | Owner | Scoped administrator | Bookable staff | Verified client / guest |
|---|---|---|---|---|
| Просмотр текущих визитов | Organization | Assigned locations | Только свои | Только доказанно своя Booking |
| Создание/перенос/отмена новых/старых | Разрешено согласно продукту и entitlements | Только выданные location rights | Только выданные права | Своя запись; client cutoffs |
| Изменение услуг, расписания, сотрудников | Organization | В пределах scope/permissions | Только собственный график при включённом self-edit, иначе запрос | Нет |
| Просмотр телефона/заметок/истории клиента | Owner в пределах роли и целей обработки | Только выданные поля и location | **Отдельное разрешение** + только связанные клиенты | Только собственные данные |
| Публикация мастера / тариф | Owner и специально защищённая роль (default owner only) | Только при отдельном делегировании, не может повысить себе права | Нет | Нет |
| Изменение owner, экспорт всех данных | Protected workflow owner | Не по умолчанию | Нет | Нет |

Effective permissions: доверенно получить identity/tenant/location из verified session/token → активные роль/назначения в этом tenant/location → union разрешённых allow permissions → затем hard ограничения owner/resource ownership/field-level/entitlement. **Default deny**; переименованные роли не меняют выдачу прав. `staff` никогда не читает чужие Booking/Customer ID через API/search/export/Telegram. Запрос guest на отмену/перенос требует scoped time-limited proof или OTP, не только телефон/ID.  Проверять CSRF при cookie auth, signed Telegram initData, webhook signature/secret, доверенный OIDC/PKCE и привязку проверенного phone, separate data collection and marketing consent. До коммерческой эксплуатации — юр./privacy review.

## 3. Атомарное Booking и данные

**Принятое продуктом:** один StaffProfile для нескольких филиалов, без автоматического travel buffer между Locations, одна услуга+мастер в Confirmed Booking. Продолжительность Service едина; post-buffer настраиваем, ресурс занимает `[startAt, occupiedUntil)`.

**Предложенный алгоритм `CreateBooking`:**
1. Вне транзакции только быстрая предварительная проверка payload/формата и capability; **все mutable условия перепроверить внутри transaction**.
2. Начать DB transaction в PostgreSQL, установить trusted tenant+actor; получить уникальный ключ идемпотентности `tenant, operation, actor-or-guest-scope, key`, не принять повтор с другим request hash.
3. Сериализовать изменения по одному мастеру блокировкой стабильной staff-row `FOR UPDATE` (либо эквивалентный проверенный transactional lock), чтобы Booking vs Scheduling edits соблюдали один lock order. Не полагаться на per-process mutex; lock в multi-tenant DB.
4. Проверить текущий staff/location/service assignment и published status, график+перерывы+исключения, интервалы, разрешения клиента, entitlement, Quote/discount snapshot и policy. Зафиксировать `startAt/endAt/occupiedUntil` в UTC, locale timezone как metadata.
5. Вставить Confirmed Booking и immutable price/discount snapshots; DB exclusion constraint **на все active occupied ranges одного `tenantId+staffId` независимо от location** служит последней защитой от overlap. `EXCLUDE USING gist (tenant_id WITH =, staff_id WITH =, tstzrange(start_at, occupied_until,'[)') WITH &&) WHERE (status IN (...active...))` — **псевдо-DDL, требуется проверка оператора, типов, списка состояний и расширения btree_gist**.
6. В той же транзакции создать event/outbox и результат idempotent command. Commit → только после этого сообщать успех; consumer worker доставляет уведомление с retry/dedup, не меняя Booking из-за сбоя Telegram/SMS.
7. При contention/exclusion violation вернуть `BOOKING_CONFLICT`; при timeout/retry запрос с прежним ключом возвращает тот же committed Booking/result, не создаёт дубль.

**`RescheduleBooking`:** тот же locking order, проверка дедлайна и нового слота в момент commit, атомарная смена времени в **той же Booking**. Если конфликт или потеря связи, исходная Confirmed остаётся. Менять услугу/мастера/филиал значит Cancel + новый Create с обычной entitlement/новой ценой; после trial новый Create запрещён. Price snapshot/promocode при time-only Reschedule не пересчитывается (ACCEPTED).

**`CancelBooking`:** атомарное состояние + release occupancy + outbox; одноразовый промокод возвращается при успешной отмене по принятым правилам, но истекший код не становится действительным. Нельзя считать `Cancelled` активной занятостью.

**`ScheduleChange`:** тот же lock discipline по staff; проверка новых/старых Confirmed, запрет молчаливой отмены. Приняты owner-configured self-edit/approval-required; при конфликте изменение не вступает в силу, пока не устранены подтверждённые брони.

**Проверить в F1 настоящим Postgres:** два конкурентных Create одного слота, параллельные по разным филиалам одного staff, policy expiry на момент commit, ре-проигрывание idempotency, crash после commit до ack, ScheduleChange vs Create/Reschedule, DST, overflow в нескольких транзакциях и failover уведомлений.

## 4. Коммерческие права, 30 календарных дней

**ACCEPTED:** 30 календарных дней с успешного создания Organization, индивидуальное коммерческое предложение заранее до регистрации; paid opt-in только добровольный, без автосписаний. Без paid после trial **no new Booking по всем каналам**; старые Confirmed: read, time-only reschedule, cancel, export.

**PROPOSED граница:** `trialStartAt` = timestamp successful tenant creation; `trialEndAt` = `trialStartAt` плюс **30 календарных дней в IANA timezone Organization с сохранением локального времени**; `trialActive` iff `startAt <= now < endAt`. Таким образом 30 **календарных**, не 30 рабочих и не принудительно 720 часов при DST. Organization timezone фиксируется на период trial для воспроизводимости; менять его после регистрации не продлевает срок. Случаи несуществующего/повторного локального времени на DST переходе формализовать через стандартную timezone библиотеку и тестовый набор (выбор конкретного disambiguation rule — F1 implementation review, без молчаливого округления). Владелец видит локальный момент окончания заранее.

**Entitlement workflow**:
- `trial_active`: создание Booking допустимо при прочих правилах.
- `trial_expired_unpaid`: новые Booking запрещены во **всех** API и каналах; старые операции/экспорт сохранены; не навязывать recurring charge.
- `paid_active`: Bookings без тарифной квоты, оплачиваемые места ограничены уникальными действующими bookable мастерами.
- `paid_inactive`: те же принципиальные ограничения новых Booking, пока нет действующего права; конкретный grace/data policy review.
- `staff_draft` не потребляет место. `staff_published_bookable` учитывается по StaffProfile ID на Organization, multi-location один раз; временно нет свободных слотов или отпуск при сохранённой публикации — **не** автоматический бесплатный seat.
- Upgrade требует отдельного явного действия владельца и согласованной оплаты, **само добавление staff profile и preview тарифа не является согласием**. Превышение capacity блокирует только активацию сверх оплаченного tier; старые Booking не отменяются.

**Отдельные pre-pilot blockers:** сколько хранить данные не оплативших салонов, формат экспорта, уведомления по существующим будущим визитам, поддержка и стоимость сообщений после trial, legitimate paid consent, деньги/чеки/НДС, РФ ПДн и лицензия. Не создаём fictitious retention deadlines или тарифы без исследования.

## 5. Screen map — готовый документальный набросок (не дизайн-макеты)

| Актор / surface | Маршрут экрана | Пустые/ошибки и права |
|---|---|---|
| Лид → салон | **Индивидуальный оффер → ознакомление и согласование условий → регистрация Organization → старт 30 дней → onboarding** | Не включать trial до регистрации; если коммерческие условия не вручены, не продолжать пилотную регистрацию |
| Owner | Setup wizard → создать услуги → добавить staff → графики → публичная ссылка → тестовая бронь → Business Calendar | Progressive disclosure; отчёт о «дней до окончания»; восстановление черновика; одна кнопка помощи |
| Owner/administrator | Calendar day/week → карточка Booking → разрешённый Reschedule/Cancel → клиент/услуга | Показать причину конфликта, старую Booking сохранить; запрет действия при insufficient scope |
| Owner | Team → StaffProfile draft → service/location assignment → Publish → при полном paid tier Upgrade offer | Создание профиля не требует upgrade; попытка Publish объясняет переполнение и не меняет текущих мастеров |
| Owner | Subscription → индивидуальный оффер/срок trial → предложение добровольной оплаты → статус/история согласия → экспорт | Нет автоматической конверсии в paid; не скрывать экспорт/существующие Booking после отказа |
| Client public web | Услуга → филиал/мастер → день/время → phone/TG identity → summary price → submit → Confirmed | Нет слотов, слот уже занят, устаревший quote, ошибка подтверждения, expired org, безопасная попытка повторить |
| Client manage | Защищённая ссылка/verified auth → своя Booking → time-only reschedule/cancel → result | Чужая запись недоступна; дедлайн истёк → обратиться к администратору; UI не сообщает успех до server commit |
| Telegram bot | /start → услуги/FAQ → выбор мастера/даты/слота → auth → Confirmed / manager handoff | Меню/кнопки, без AI; одинаковая Booking API policy и обработка старого callback |
| iframe/embed | iframe shell → тот же Booking UI → Confirmed | postMessage только по allowlisted origin, scoped actions, no secrets from parent; third-party cookie fallback |
| Telegram Mini App (F2 target) | trusted initData → тот же Booking UI → Confirmed | не доверять initDataUnsafe; поведение web не меняется, если Telegram недоступен |

**Качество на мобильном:** не полагаться на JS framework label; выполнить реальные keyboard navigation, accessibility, stable scrolling, affordable device, Telegram WebView tests, focus/pending/error states. Lighthouse/INP/LCP/CLS budget выбрать после первого прототипа/реальных замеров, не выдумывать метрики.

## 6. GitHub execution order (после отдельно разрешённого F1)

1. `#16` bootstrap + CI/testing + PostgreSQL test DB + contracts + migration skeleton, без vendor lock-in.
2. `#17/#18/#19` minimal kernel/module contracts, tenancy/authn/authz, persistence/transactional outbox, observability.
3. `#20/#21/#22` staff+service+scheduling, atomic Booking, REST/OpenAPI, idempotent concurrency.
4. `#23` минимальный web client and business calendar, F1 end-to-end gate.
5. `#24/#26/#27/#29/#30/#35` минимальные pilot-specific UX, сценарный Telegram, notifications, trial/entitlements — **до** реального салона; #37/#38 security/operations обязательны перед реальными ПДн. Остальные F2 add-ons — отдельная очередь.
6. `#39` договор/персональные офферы/платежи/обратная связь/измеренные метрики, а **не** выдуманный публичный прайс.

**Definition of Ready для инженерного Issue:** ссылка на REQ+ACCEPTED product DEC, предложенный и одобренный ADR/default, business owner, негативный test, dependency, pilot/F1 scope. Для нового небезопасного допущения делать заметку на PR и отдельное ревью, не прятать в коде.

## 6a. Детальный контракт реализации и negative tests

- [Доменные контракты и инварианты](f0-contracts-and-invariants.md) уточняют запись/промокоды, общую БД и locks, tenant/guest access, subscription states, архивирование мастеров и состояние ПДн после trial.
- [41 сценарий приёмки](../quality/f1-pilot-acceptance-cases.md) разделён на F1/Pilot/Pre-real-pilot gates. Эти тесты **спроектированы, но не выполнены**.
- [Эксплуатационный runbook](../operations/pilot-operational-readiness.md) определяет observability, safety-first incident recovery, export/retention/backup gates.
- [Конкурентная проверка и сценарная экономика](../product/market-economics-validation.md) не принимает новые цены, но фиксирует фактические расхождения публичных тарифов.

## 7. Список специально оставленных инженерных альтернатив

- Go backend — если F1 измерения показывают недопустимый footprint или throughput, а эксплуатационная стоимость компенсирует второй язык.
- React — если реально нужная accessibility/calendar экосистема Svelte недостаточна при равном UX.
- SSR/SvelteKit — если публичные страницы салона должны индексироваться поиском по актуальному product case и это оправдывает runtime.
- pg-boss / River / свой outbox poller — выбирать job library после backend stack и оценки гарантированной доставки; retry/dedup обязательны независимо.
- Kysely vs typed SQL generator — выбрать по миграциям, Postgres constraints, тестам; любые исключения и row locks должны оставаться в проверяемом SQL.

**Этот blueprint не снимает изначальный статус ADR-0001–0005 PROPOSED**. После единого review owner можно обновить ADR как ACCEPTED и только отдельной командой начать F1.
