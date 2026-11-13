# ADR-0003 — Атомарное бронирование и согласованность графика

**Статус: PROPOSED** · Issue #11 · REQ-002,003,006.

## Решение на ревью
Один Bookings domain API для всех каналов, одни правила availability и booking. PostgreSQL фиксирует активные booking intervals транзакционно, с DB-level защитой от overlap (проверить exclusion constraint по tenant+staff+time-range, исключив отменённые состояния). Команды используют idempotency key, tenant context и контроль permission. Перенос — атомарное изменение старой/новой брони по согласованной статусной модели.

## Отличия read vs write
Availability query может отобразить слот, потерявший доступность до подтверждения. CreateBooking проверяет ещё раз и возвращает domain conflict (409/BOOKING_CONFLICT) с возможностью обновить слоты.

## График и бронь
Добавление отпуска или сокращение смены при наличии визитов не может молча оставить противоречивые брони. Booking и Scheduling должны участвовать в синхронизированном протоколе изменения доступности (напр. staff/day lock и проверки внутри транзакции) или в одном консистентном агрегате. Конкретная стратегия выбирается после concurrency spike, а не по названию «модуль».

## Время и статусы
UTC instants + IANA timezone, explicit service duration/buffer. Состояния Confirmed / CancelledByClient / CancelledByBusiness / Completed / NoShow; hold/Pending только при явно предусмотренном TTL.

## Не выбранные подходы
Клиентская блокировка слота; только in-memory mutex; отдельный scheduler microservice без гарантированной транзакции; AI прямой UPDATE booking.

## Acceptance
Load/concurrency tests, DST/границы суток, idempotent replay, compare schedule change vs booking, multi-tenant conflict isolation; решение зафиксировать до #21.
