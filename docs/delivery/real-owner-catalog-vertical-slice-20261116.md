# F1: сквозной срез 02 — каталог услуг владельца

**Статус:** инженерный Draft. Основа — PR #225 (проверенный Telegram Mini App вход), PR #221/217/211. Не является разрешением production/реальных ПДн или публичной записи.

## Проверяемая пользовательская история

1. Владелец входит в закрытое Telegram Mini App через криптографически проверенный initData. Сессия подтверждается существующим `session-context`.
2. Cookie загружает **реальные услуги из PostgreSQL** через защищённый `GET /v1/organizations/:tenantId/services`. На пустой DB показывается пустое состояние, а при ошибке — отказ, не макет.
3. Владелец вводит название, длительность (1–1440 минут), базовую стоимость в целых ₽ и создаёт **черновик**. `POST /v1/organizations/:tenantId/services` возвращает ID, цену в копейках, длительность, дату и `active=false`.
4. Перезагрузка страницы через новый Telegram launch и обновление списка возвращает тот же сохранённый объект. Никакой клиент не может записаться на этот черновик.
5. Повтор отправки с тем же `Idempotency-Key` и payload возвращает прежний ID (200); первый запрос — 201. При изменённом payload под тем же ключом — 409. Web сохраняет ключ при неизвестном результате и не выполняет автоматический retry.

## Безопасность и консистентность

- Таблица `cookie_catalog.service_create_receipts` создана миграцией `0026`; Service уже существует в схеме `0004`. SQL сохраняет Service и receipt в одной транзакции. Все строки обязательно tenant-scoped; повтор сериализован transaction advisory lock + UNIQUE.
- Привилегии `catalog.service.read/create` назначаются реальной owner-роли при provision и существующим owner-ролям отдельной миграцией. Сессия/ссылка Telegram, tenant, membership, roles и permission повторно проверяются и блокируются PostgreSQL до COMMIT через `requireTenantPermission`. Роль, tenant или Permission не берутся из браузерного запроса.
- Продаж, publish, override-цен, скидок, staff assignment, клиентских данных или Booking в этом срезе нет. Стоимость — целые копейки без JS float на API; ввод в UI — целые рубли.
- Server DTO, ошибки и лимит выдачи (100 услуг) проверяются до отображения, в том числе отсутствие 200 на невалидный ответ. Нет повторного использования `sessionStorage` API mode.
- Ответы и ошибки защищённых маршрутов: `Cache-Control: no-store`; закэшированная авторизация не должна открыть чужой салон.

## Регрессия

`pnpm test:integration`: реальная PostgreSQL 16/17, синтетическая Telegram HMAC-привязка, настоящий bearer, создание после provision, одновременный дубль idempotency, изменённый payload, невалидное тело, cross-tenant 403, отзыв разрешений/сессии 403/401 и сохранённая единственная строка.

`pnpm --filter @cookie/web check`: API transport fetch mocks, строгие DTO, auth scope/expiry, ошибки без synthetic success. Весь repo CI дополнительно проверяет lint, format, boundaries, TypeScript, builds, browser smoke, migrations/restore и staging Compose.

## Зависимости и ещё не выполнено

Этот PR stacked на #225, параллельный #227 workspace-overview изменяет app.ts/main.ts и должен быть интегрирован отдельно с rebase/review. #218 миграции и #113/#165/#175 безопасность общего Booking остаются блокерами. Нельзя объявлять `#203` выполненным, пока owner self-signup, staff/schedule/public book/calendar, staging и реальный браузерный E2E не реализованы и не проверены.
