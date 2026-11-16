# F1 — Telegram Mini App: криптографическая проверка initData

**Статус:** техническая реализация проверяющего port; **не является работоспособным Cookie AuthN** и не разрешает производственное подключение. Связанные #18, #22, #66, ADR-0004, DEC-005/007/095.

## Граница доверия

- Браузер Telegram отправляет **исходную строку** `Telegram.WebApp.initData` на сервер. Нельзя доверять `initDataUnsafe`, Telegram username, выбранному клиентом tenantId, Identity или Customer.
- `packages/platform-identity/src/telegram-init-data.ts` проверяет HMAC-SHA256 в соответствии с Telegram WebAppData: key = HMAC-SHA256(bot token, `WebAppData`); hash = HMAC-SHA256(sorted decoded key=value fields, key). Проверка хэша — с постоянным временем сравнения.
- Для bot-owner HMAC данные включают **все параметры, кроме `hash`**, в том числе опциональный `signature` (он аутентифицируется HMAC, но не становится ролью/credentials Cookie). Только отдельный алгоритм третьей стороны Ed25519 исключает одновременно `hash` и `signature`. Эти способы проверки нельзя смешивать.
- Проверяются уникальность параметров после decoding, корректная URL/UTF-8 кодировка, ограничение размера, `auth_date` и явное максимальное время жизни данных. Тесты используют только **синтетический** bot token, Telegram ID и серверные часы.
- Выход: только `{channel: "telegram-mini-app", telegramUserId, authDateUnixSeconds}`. **Это не Cookie VerifiedSession** и не доступ к бронированию.

## Чтобы получить реальный Cookie-вход

1. Подключить секрет **конкретного Telegram-бота** на сервере, не добавляя его в Vite/web/client, URL, cookies, логи, тестовые артефакты или GitHub. Определить правила ротации bot token.
2. Реализовать проверенное и уникальное связывание Telegram user ID → внутреннего `Identity` и разрешённого `Customer` конкретной Organization. Не связывать по username, имени, случайному номеру телефона или неподтверждённому клиентскому ID; предусмотреть unlink/revocation и запись согласия.
3. Выдавать отдельную короткоживущую защищённую Cookie-сессию с серверным tenant scope, сроком, issuer/audience и отзывом. Использование `initData` напрямую как долговременного bearer-токена запрещено. Для F1 разработан **внутренний** PostgreSQL opaque-session port (описан ниже), но его нельзя подключать к публичному API без real link/session policy.
4. Подключить live AuthN provider к `BearerSessionVerifier` и AuthZ `requireTenantPermission` + entitlement в **каждом** Booking HTTP запросе; проверить гонки отзыва #113, ownership клиента, поля ответа и аудит.
5. Только после утверждения API DTO/session/cookie policy в #18/#22/#66 добавлять публичный Mini App экран и web API adapter. Обязательно отдельное одобрение ПДн/пилота/production.

**Текущее ограничение:** модуль намеренно не импортируется из `apps/api/src/main.ts` или `apps/web/**`; тестовое API по-прежнему недоступно при обычном старте.

Официальная спецификация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

## F1 — одноразовый обмен proof → непрозрачная сессия (PROPOSED, synthetic only)

Файлы: `packages/platform-identity/src/opaque-sessions.ts`, migration `0022_opaque_identity_sessions.sql`, `apps/api/test/opaque-telegram-sessions.integration.test.ts`.

- Только сервер вызывает `exchangeTelegramInitData(rawInitData)`; проверка HMAC, свежести и структуры всегда выполняется **перед** обращением к resolver. Поля запроса не содержат и не выбирают Cookie `tenantId`, `identityId`, роль или Customer.
- Обязательный `resolveVerifiedTelegramLink` выполняется внутри одной PostgreSQL транзакции и должен искать **уже подтверждённую и согласованную** уникальную связь Telegram user ↔ Identity, tenant. **Реальный resolver и процесс связывания ещё не реализованы**; тесты используют явный синтетический callback. Если связи или активного Membership нет — сессия не создаётся.
- После успешного разрешения связи генерируется 256-битный случайный bearer `cs_...`; в БД остаётся только SHA-256 токена, а не сам токен. Срок по часам PostgreSQL, issuer/audience должны точно совпадать при проверке. F1-bound TTL 60–3600 секунд **предложен технически**, не принят как коммерческая политика.
- Hash **проверенного** Telegram `initData` используется как одноразовый nonce: повтор даже с другим порядком query-параметров не выдаёт вторую сессию. Невалидные и неподтверждённые proof не расходуют nonce; ошибки resolver откатывают транзакцию.
- Отзыв по предъявлению точного bearer, истечение срока и отключение Membership немедленно лишают доступа; триггер при Membership disable отзывает ранее выданные сессии и не допускает «оживления» после включения Membership обратно. Полная смена прав роли продолжает проверяться отдельным scoped AuthZ.
- Новый provider структурно реализует `BearerSessionVerifier`, но **не импортируется и не включается из** `apps/api/src/main.ts`. Нет публичной выдачи токена, cookies, реального Telegram-бота, account linking, client self-service, Customer ownership или production deployment.

**Непройденные release gates:** принятая политика согласий и уникального связывания, bot credential provisioning/rotation, подтверждение доставки Cookie-сессии и HTTPS/cookie/CSRF, связанное аннулирование на Telegram unlink, rate limits, защита от отзыва отдельной сессии **после** preflight, но **до** COMMIT бизнес-команды, матрица rights/entitlements, tenant/customer scope и юридический контроль ПДн. Нельзя считать runtime AuthN готовой только из-за этих внутренних контрактов.
