# F1 — Telegram Mini App: криптографическая проверка initData

**Статус:** техническая реализация проверяющего port; **не является работоспособным Cookie AuthN** и не разрешает производственное подключение. Связанные #18, #22, #66, ADR-0004, DEC-005/007/095.

## Граница доверия

- Браузер Telegram отправляет **исходную строку** `Telegram.WebApp.initData` на сервер. Нельзя доверять `initDataUnsafe`, Telegram username, выбранному клиентом tenantId, Identity или Customer.
- `packages/platform-identity/src/telegram-init-data.ts` проверяет HMAC-SHA256 в соответствии с Telegram WebAppData: key = HMAC-SHA256(bot token, `WebAppData`); hash = HMAC-SHA256(sorted decoded key=value fields, key). Проверка хэша — с постоянным временем сравнения.
- Для опционального современного параметра `signature` используется **bot-owner HMAC**, а не проверка Ed25519 для третьих сторон. Значение `signature` не считается проверенной клиентской claim и не выдаётся вызывающей стороне.
- Проверяются уникальность параметров после decoding, корректная URL/UTF-8 кодировка, ограничение размера, `auth_date` и явное максимальное время жизни данных. Тесты используют только **синтетический** bot token, Telegram ID и серверные часы.
- Выход: только `{channel: "telegram-mini-app", telegramUserId, authDateUnixSeconds}`. **Это не Cookie VerifiedSession** и не доступ к бронированию.

## Чтобы получить реальный Cookie-вход

1. Подключить секрет **конкретного Telegram-бота** на сервере, не добавляя его в Vite/web/client, URL, cookies, логи, тестовые артефакты или GitHub. Определить правила ротации bot token.
2. Реализовать проверенное и уникальное связывание Telegram user ID → внутреннего `Identity` и разрешённого `Customer` конкретной Organization. Не связывать по username, имени, случайному номеру телефона или неподтверждённому клиентскому ID; предусмотреть unlink/revocation и запись согласия.
3. Выдавать отдельную короткоживущую защищённую Cookie-сессию с серверным tenant scope, сроком, issuer/audience и отзывом. Использование `initData` напрямую как долговременного bearer-токена запрещено. Определить replay-защиту на auth exchange и rate limiting; HMAC+TTL сами по себе не предотвращают повтор в окне.
4. Подключить live AuthN provider к `BearerSessionVerifier` и AuthZ `requireTenantPermission` + entitlement в **каждом** Booking HTTP запросе; проверить гонки отзыва #113, ownership клиента, поля ответа и аудит.
5. Только после утверждения API DTO/session/cookie policy в #18/#22/#66 добавлять публичный Mini App экран и web API adapter. Обязательно отдельное одобрение ПДн/пилота/production.

**Текущее ограничение:** модуль намеренно не импортируется из `apps/api/src/main.ts` или `apps/web/**`; тестовое API по-прежнему недоступно при обычном старте.

Официальная спецификация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
