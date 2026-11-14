# Cookie F1 — этап #16: запускаемый инженерный каркас

**Статус:** implementation PR, **не пилот и не готовая CRM**. Пользователь утвердил F0-P01–F0-P12 и явно разрешил F1. Реальные персональные данные, коммерческие платежи и production deployment запрещены.

## Что есть в первом PR

- Node.js 26 LTS + TypeScript, pnpm workspace; Fastify API и базовые защищённые health endpoints.
- `GET /health/live` — работает без подключения к БД, `GET /health/ready` — исполняет `SELECT 1`, при сбое 503 без утечки ошибок.
- PostgreSQL 16 только для синтетических данных; версионируемые миграции со SHA-256, PostgreSQL advisory lock и rollback.
- Svelte 5/Vite static **инженерный экран**, без заявлений о работающем бронировании.
- Unit tests и интеграционный тест миграций, типизация/линтер, CI с PostgreSQL service. **Status до проверки CI: NOT VERIFIED**.
- Создание Organizations, реальные Bookings, тарифы, authZ, kernel registry, уведомления и payments **отсутствуют** и должны появиться следующими независимыми PR.

## Локальный старт (только synthetic)

```sh
corepack enable
pnpm install --no-frozen-lockfile
docker compose -f docker-compose.dev.yml up -d
export DATABASE_URL=postgres://cookie_dev:cookie_dev@127.0.0.1:5432/cookie_dev
pnpm db:migrate
pnpm dev:api
# в другом терминале
pnpm --filter @cookie/web dev
```

Проверка API: `GET http://127.0.0.1:3000/health/live`, `GET http://127.0.0.1:3000/health/ready`. PostgreSQL не должен быть открыт на внешнем интерфейсе — порт привязан к 127.0.0.1.

## Quality / оставшийся gate

CI не должен трактоваться как успешный до реального GitHub Actions run. Результаты проверять в PR. В первой итерации зависимости зафиксированы точными версиями на прямом уровне, а **lockfile необходимо создать и включить в PR до merge**. Временный `pnpm install --no-frozen-lockfile` в CI нужен только для генерации lockfile; после фиксации перейти на `--frozen-lockfile`.

- [ ] Реальный `pnpm lint/typecheck/test/test:integration/build` — PASS в CI.
- [ ] Сгенерированный `pnpm-lock.yaml` добавлен в PR, CI использует frozen lock.
- [ ] No business logic in minimal kernel.
- [ ] UI не выдаёт старты бронирования или платных услуг за готовую функциональность.
- [ ] Нет токенов, секретов и реальных ПДн.

Далее: #17 minimal kernel contracts, #18 tenancy/identity/policy, #19 persistence/outbox, #20 staff/catalog/schedules, #21 Booking engine. Не ускорять пилот в обход F1 proof.
