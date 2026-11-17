# F1: сквозной срез 03 — мастера и назначения черновиков

**Статус:** Draft engineering, без production/ПДн/коммерческого пилота. Стек: PR #230 → #228 → #225 → #221 → #217 → #211. #227 workspace overview — независимый параллельный PR.

## Пользовательская история

1. Владелец проходит подписанный Telegram-вход, получает краткоживущий серверный bearer и открывает реальный кабинет.
2. Между двумя настоящими разделами **«Услуги»** и **«Мастера»** можно переключаться без доступа к демо-календарю и синтетическим данным.
3. Раздел мастеров запрашивает защищённый `GET /v1/organizations/:tenantId/staff`: список профилей и филиалов; отдельно использует реальный `/services` для выбора услуги.
4. Владелец вводит имя/псевдоним мастера, необязательную должность на витрине, филиал и существующую услугу, затем отправляет `POST /v1/organizations/:tenantId/staff` с `Idempotency-Key`. Сервер создаёт профиль **один раз на Organization**, связь с Location и Service, а также квитанцию — **в одной транзакции**.
5. И профиль, и назначение сохраняются в PostgreSQL, при повторном GET возвращаются с тем же ID. Профиль `bookable=false`; назначения `active=false`: публичная запись не разрешена.
6. Параллельные идентичные POST c одинаковым ключом возвращают 201 + 200 и один профиль. Изменённый payload с тем же ключом → 409.

## API и ограничения безопасности

- Миграция `0027_staff_draft_create.sql` добавляет `position_title` (только витрина, **не RBAC**), tenant+actor+key replay receipts и owner-права `staff.profile.read/create`. При operator owner provisioning новые права появляются сразу, старым owner ролям добавляет миграция.
- В API mode Staff маршруты монтируются **только** с реально настроенным Telegram verifier, без синтетического bypass.
- `withTenantPermission` переиспользуется из Catalog: PostgreSQL transaction, блокировка membership/assignment/roles/bearer/link до COMMIT, deny + audit, tenantId/identityId только из server-verified actor, жёсткое разделение tenant. Вся запись атомарна.
- Перед INSERT Location и Service должны принадлежать **текущему** tenant; чужие/удалённые ID отвечают одинаковым 404. Клиент не задаёт `tenantId`, `actor`, `active`, `bookable` и `permissions`.
- GET ограничен 100 профилями, 100 филиалами и 1000 строк назначений; переполнение вызывает fail-closed, а не обрезанную успешную выдачу.
- HTTP no-store и Authorization-aware Vary на списке/создании. Web строго проверяет структуру DTO, ссылки на филиалы, пустой список и ошибки, не кэширует bearer или данные в браузерном storage, сохраняет idempotency key после uncertain response.

## Проверяемые регрессии

- PostgreSQL 16 + 17: настоящая HMAC Telegram связка, сессия, owner provision → Service draft → Staff draft + Location/Service links, одновременные replay POST, конфликт ключа, разные tenant для ссылки/услуги, неизвестные/недопустимые поля, отзыв permission и logout; запросы по чужому tenant и default-closed route без live verifier.
- Web unit: owner bearer + no-store, GET/POST wire contract, неверные/чужие записи, дублирующиеся ID, 401/403/404/409/503, offline и истёкший bearer.
- Repo workflow: Prettier, eslint, границы модулей/UI, TS, unit, PG16/17 integration, restore, Svelte check/build, Chromium synthetic smoke, Docker Compose staging.

## Не реализовано

Мастер **не опубликован** и не может принимать бронирования. Настройка графика, включение bookable с entitlement/tier, перенос/отмена бронирований, платёжный провайдер, self signup, браузерный real-mode E2E с Telegram, законная работа с ПДн и production approval — отдельные контрольные точки. #113/#165/#175/#218 не закрыты; не утверждать готовность #20/#23/#203.

Temporary F1 directory safety bound: new draft profiles stop at 100 per tenant (409 `staff-capacity-reached`); a tenant-scoped transaction advisory lock serializes creation and exact replay still succeeds at capacity. This is not a commercial seat quota; active/bookable entitlement is independent. Future assignment and location writers must preserve read bounds or implement pagination.
