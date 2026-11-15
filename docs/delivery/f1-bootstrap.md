# Cookie F1 — этап #16: запускаемый инженерный каркас

**Статус:** implementation PR, **не пилот и не готовая CRM**. Пользователь утвердил F0-P01–F0-P12 и явно разрешил F1. Реальные персональные данные, коммерческие платежи и production deployment запрещены.

## Что есть в первом PR

- Node.js 26 LTS + TypeScript, pnpm workspace; Fastify API и базовые защищённые health endpoints.
- `GET /health/live` — работает без подключения к БД, `GET /health/ready` — исполняет `SELECT 1`, при сбое 503 без утечки ошибок.
- PostgreSQL 16 только для синтетических данных; версионируемые миграции со SHA-256, PostgreSQL advisory lock и rollback.
- Svelte 5/Vite static **инженерный экран**, без заявлений о работающем бронировании.
- Unit tests и интеграционный тест миграций, типизация/линтер, CI с PostgreSQL service. **Статус проверки: CI PASS на GitHub Actions 2026-11-14** (см. ссылку ниже).
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

CI не должен трактоваться как успешный до реального GitHub Actions run. Результаты проверять в PR. Прямые версии зависимостей зафиксированы, **`pnpm-lock.yaml` сгенерирован GitHub Actions и закоммичен в feature-ветку**. CI выполняет строго `pnpm install --frozen-lockfile`; временные workflow с правом записи удалены. Первые неудачные прогоны исправлены, актуальные push и pull request CI успешны.

- [x] Реальный `pnpm lint/typecheck/test/test:integration/build`, `format:check`, `check:boundaries` и Svelte check/build — **PASS** в [GitHub Actions run #43630116660](https://github.com/tim8es/cookie/actions/runs/43630116660).
- [x] `pnpm-lock.yaml` добавлен в PR; CI использует frozen lock.
- [x] No business logic in minimal kernel: kernel business code в этом PR отсутствует, а начальная проверка запрещает upstream contracts/kernel imports из application/domain/platform.
- [x] UI не выдаёт старты бронирования или платных услуг за готовую функциональность.
- [x] В изменённых файлах нет настоящих токенов, секретов и реальных ПДн; dev/CI PostgreSQL использует явно синтетические учётные данные.

Далее: #17 minimal kernel contracts, #18 tenancy/identity/policy, #19 persistence/outbox, #20 staff/catalog/schedules, #21 Booking engine. Не ускорять пилот в обход F1 proof.

## Evidence текущего PR

- [PR #45 (stacked на F0 PR #43)](https://github.com/tim8es/cookie/pull/45).
- [GitHub Actions PR run — PASS](https://github.com/tim8es/cookie/actions/runs/43630116660), [push run — PASS](https://github.com/tim8es/cookie/actions/runs/43630114654), commit `d1dfdf169c90d88ef76b2c8beda212aa818679f8`.
- Проверены: frozen install, ESLint, Prettier source check, import boundary checker, TypeScript, API/Config/Contract unit tests, PostgreSQL migration integration, API/server build и Svelte check/Vite build.
- **Не проверено:** настоящие бронирования, атомарные слоты, production load, настоящие ПДн/юридические согласия, платёжные сервисы. Это последующие F1/F2 gates, не заявлять иначе.
