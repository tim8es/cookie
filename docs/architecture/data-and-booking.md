# Данные и инварианты записи

**Статус: PROPOSED.** Бизнес-инварианты обязательны; конкретная схема PostgreSQL не утверждена.

## Предметные сущности
Organization, Location, Staff, Service, StaffService, ScheduleRule, ScheduleException, Customer, Booking, Visit, PriceSnapshot, IdentityLink, AuditEvent. Tenant isolation применим к организациям и дочерним данным. CRM Customer и login Identity — разные понятия.

## Инварианты
- Сначала одна услуга, один специалист и один непрерывный период. Сложные цепочки услуг/оборудование позже по ADR.
- Все интервалы сохранять как абсолютные даты/UTC; IANA timezone организации применять для отображения, расписаний и DST.
- Доступность учитывает длительность, перерывы, исключения, отгулы и уже активные записи.
- Два параллельных запроса на пересекающийся интервал одного сотрудника не создают два активных бронирования.
- API поиска слотов даёт предварительный результат, команда брони повторно проверяет и фиксирует атомарно.
- Повторы запросов с idempotencyKey в пределах tenant/actor не создают дополнительные брони.
- Изменения графика с существующими бронями требуют явного разрешения конфликтов; недопустимо молча отменять их.
- Сервер делает authorization на чтение/перенос/отмену, ссылки для гостей должны иметь ограниченный срок/подтверждение.

## Предлагаемая стратегия
Транзакции PostgreSQL и DB-level проверка пересечения временных диапазонов (возможный exclusion constraint на tstzrange, btree_gist), дополненная синхронизацией операций booking/change-schedule. Оформить ADR и stress/concurrency spike. Не полагаться только на проверку свободных окон в коде.

## Статусы (черновик)
Confirmed, CancelledByClient, CancelledByBusiness, Completed, NoShow. Pending/hold только при явном TTL и recovery mechanism. История статусов сохраняется. Финансовая операция и закрытая бронь — разные сущности.

## Владение данными
Catalog владеет услугами, Staff — мастерами, Scheduling — исключениями/часами, Customers — контактами, Bookings — бронями и историей. Reporting строит агрегаты, не изменяя операционные данные. Чужие таблицы читают через публичные read ports.

## Commands/events
CreateBooking, RescheduleBooking, CancelBooking; booking.created, booking.rescheduled, booking.cancelled, visit.completed. Внешняя доставка через transactional outbox и idempotent consumers.

## Вопросы
Отсроченная оплата и слот hold, мультиуслуги, ресурсы, несколько филиалов, отрезки по ночам, буферы, смена цены, overlapping staff across businesses, ручные брони админа, правила late cancellations.

## Тесты
Массовый параллелизм; перебои после commit; дубли event; отказ интеграции; отпуск после уже назначенных броней; чужой tenant; DST и границы суток.
