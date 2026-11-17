# F1: контроль границ модулей — постепенное внедрение

**Статус: IMPLEMENTATION PROPOSAL (#201).** Принятое решение ADR-0001 — модульный монолит с минимальным kernel. Этот PR добавляет предотвращение новых нарушений, **не утверждает**, что все существующие модули уже изолированы или готовы к отдельному развёртыванию.

## Что проверяет CI

Команда `pnpm check:boundaries` запускает анализ всех производственных TypeScript-файлов `packages/*/src` и `apps/*/src`, затем восемь отрицательных и положительных тестов анализатора. Для Svelte-компонентов продолжает действовать отдельный `pnpm check:ui`.

1. Локальные импорты разрешены только внутри собственного `src` модуля.
2. Новые прямые импорты внутренней реализации другого Domain/Platform/API модуля запрещены. Можно использовать явно опубликованные upstream entrypoints `@cookie/contracts` и `@cookie/kernel`; deep package aliases не допускаются.
3. Анализируются обычные статические импорты, реэкспорты, `import type`, литеральные `import()` и `require()`.
4. **39 оставшихся существующих импортов** (было 55 до поэтапной изоляции) временно закреплены в `scripts/module-boundaries-legacy.json` как технический долг, точно по имени импортирующего файла и строке импорта. Новые связи автоматически в этот файл не добавляются. При удалении старой связи исключение тоже должно быть удалено — CI обнаруживает устаревшую запись.
5. Новые проверки выполняются существующим F1 workflow; отдельный дублирующий CI не создаётся.

## Что остаётся архитектурным долгом

- Booking обращается напрямую к внутренним файлам Identity, Scheduling и Outbox, а также читает SQL-таблицы Catalog, Staff, Scheduling и Customers.
- `domain-scheduling` использует `platform-db` Outbox. Обратная зависимость из `platform-db` в Scheduling удалена в следующем отдельном PR посредством `booking-read-adapter`; физический пакетный цикл разорван, но SQL ещё читает таблицы нескольких доменов.
- `createKernel` реализован и протестирован как библиотека, но не используется как реальный composition root приложения.
- Checker **пока не проверяет** владение SQL-схемами, динамические импорты с вычисляемыми путями, Svelte-компоненты или полную независимость модулей. Но теперь он проверяет и запрещает циклы зависимостей производственных TypeScript-модулей. Зеленый CI не следует трактовать как отсутствие этих рисков.

## Как устранять остаточные нарушения

1. Сначала зафиксировать транзакционные публичные порты для Booking ↔ Identity/Policy, Catalog/Staff/Scheduling/Customers и Outbox. **Все проверки бронирования обязаны оставаться в одной PostgreSQL-транзакции**, сохраняя порядок блокировок, идемпотентность, исключающие ограничения и fail-closed semantics. Нельзя «изолировать» модуль переносом атомарного решения в асинхронные события.
2. Вводить публичные entrypoints и убирать конкретные исключения из baseline постепенно, по одному небольшому PR с PostgreSQL concurrency/security-регрессией.
3. Выделить прикладной read adapter для Booking: `platform-db` больше не импортирует `domain-scheduling`, checker обнаруживает новый цикл. Контроль владения SQL-схемами остаётся отдельной архитектурной задачей.
4. Описать composition root для доверенных зарегистрированных модулей отдельно от tenant entitlement и прав пользователя. Никакой произвольной hot-load системы или микросервисов на F1.

**Релизные ограничения не меняются:** только синтетические данные. Production, реальные ПДн, платёжные и внешние провайдеры требуют отдельного согласования.

## Следующий этап: опубликованные F1-порты Booking

В отдельном дочернем PR после защитного #204 бизнес-команды `CreateBooking`, `CancelBooking`, `RescheduleBooking` переведены на три узких публичных entrypoint:

- `domain-scheduling/src/index.ts` — существующие чистые вычисления доступности;
- `platform-identity/src/index.ts` — серверная авторизация `requireTenantPermission` и доверенный `TrustedActor`;
- `platform-db/src/index.ts` — транзакционный `enqueueOutbox`.

Checker пропускает точный относительный путь `packages/<module>/src/index.js` между производственными пакетами и блокирует остальные `src/*` реализации, `apps/*` и зависимости `kernel/contracts → domain/platform`. Публичность в этом этапе — **входной файл в монорепозитории**, а не уже опубликованный NPM package export или версионируемый контракт. Для полноценного versioned API нужны отдельные package entrypoints и договорённость о совместимости.

Удалены **16 точных исключений** из исходных 55: 11 импортов Booking (включая две ранее уже публичные Scheduling entrypoints), один Scheduling index в `platform-db` и один Contracts index в API. Оставшиеся 39 исключений продолжают запрещать прирост технического долга.

**Важное ограничение:** реализация `requireTenantPermission`, Outbox, SQL-чтение чужих схем, порядок блокировок и жизненный цикл ядра не меняются. После выделения отдельного `booking-read-adapter` цикл `platform-db ↔ domain-scheduling` исчезает на уровне импортов, и checker проверяет его отсутствие. Это ещё не доказывает отсутствие междоменных SQL-запросов.

## Следующий отдельный PR: разрыв зависимости `platform-db → domain-scheduling`

- `readBookingAvailability` перенесён из `packages/platform-db/src/booking-availability.ts` в публичный `packages/booking-read-adapter/src/index.ts`.
- API `booking-http.ts` вызывает новый adapter через публичный входной файл, оставаясь владельцем того же `PoolClient` и существующей read transaction.
- SQL-запросы, проверка `requireTenantPermission`, `listAvailableSlots`, UTC/DST, расчёт интервалов, фильтр прошедших слотов и DTO **не изменены**. Подтверждение Booking по-прежнему выполняется независимой командой с повторной проверкой внутри транзакции; read adapter не удерживает слот.
- Адаптер намеренно читает таблицы Staff, Catalog, Scheduling и Booking, поэтому это **прикладной агрегирующий read adapter**, а не владелец этих схем. Для будущего запрета cross-schema SQL потребуется отдельный согласованный ADR о транзакционных read ports.
- Удалены ещё **3 точные записи baseline**, 42 → 39. Checker теперь блокирует циклы между любыми `packages/*/src` и `apps/*/src` по статическим импортам, включая разрешённые публичные entrypoints и унаследованные приватные зависимости.
- **Не проверяется:** runtime computed `import(variable)`, владение SQL-таблицами, Svelte-импорты, сторонние npm dependencies и цикл на уровне динамической инфраструктуры. Статический CI не является доказательством безопасности всей архитектуры.

В этом PR нет новых миграций, внешних каналов, микросервисов, production запуска или изменений бизнес-команд Booking.

## Phase 4: Scheduling → public Identity and Outbox capabilities

Nine Scheduling implementation files now consume the already published `platform-identity/src/index.js` and `platform-db/src/index.js` entrypoints instead of importing the implementations directly. The exact legacy baseline decreases **39 → 17**. The public entrypoints re-export the same implementations; no SQL, lock order, transaction boundaries, authorization, idempotency, or event behavior changes. No new runtime capability or product settings are introduced.

`publish-shift.ts` is deliberately excluded while #245 overlaps it. The remaining cross-schema SQL, narrow transaction-scoped repository ports, production composition root, tenant entitlements, and package exports remain separate #201 follow-ups. This is an incremental boundary cleanup, not proof of runtime isolation. Verify the boundary checker, TypeScript and PostgreSQL regression gates on the resulting PR before merging.
