# Cookie F0 — исполнимые контракты и граничные случаи

**Статус:** PROPOSED engineering baseline для одного owner-review, не ACCEPTED и не результат реализации. Основание — [PRD](../product/requirements.md), [принятые DEC](../decisions/register.md), [blueprint](f0-implementation-blueprint.md), ADR-0001/0003/0004/0006. Требования к коммерческому поведению (DEC-099–113) имеют приоритет над техническими предложениями ниже.

## 1. Владение данными, зависимости, границы модулей

| Модуль | Собственные сущности | Только его команда меняет состояние | Допустимые входы |
|---|---|---|---|
| Organization/Tenancy | Organization, Location, active tenant context | CreateOrganization/SetOrganizationSettings | authenticated owner invite / trusted registration |
| Identity/Access | Identity, Membership, RoleAssignment, proof-of-ownership | VerifyPhone, LinkTelegram, GrantRole | trusted auth adapters and explicit policy |
| Catalog/Staff | Service, StaffProfile, StaffLocationAssignment, staff service catalog, price config | Publish/ArchiveStaff, SetService, SetAssignment | scoped admin commands, entitlement at publish |
| Scheduling | ScheduleRule, ScheduleException, pending schedule changes | ChangeSchedule, Submit/ApproveScheduleChange | staff permission or owner/admin; Booking lock protocol |
| Booking | Booking, PriceSnapshot, PromoRedemption link, command idempotency | Create/Reschedule/Cancel/Complete/NoShow | single domain API, no Telegram/web direct DB writes |
| Pricing | Quote, Discount/Promotion configurations, policy versions | Quote/SetDiscount/CalculateOrder | immutable quote snapshot used by Booking transaction |
| Subscription | Trial, paid entitlement, offer/acceptance audit, staff-capacity | ChangeEntitlement/ActivatePaid, CanCreateBooking | owner verified paid consent + payment evidence |
| Notifications | OutboxEvent, DeliveryAttempt, channel subscription | queue/schedule/send/retry | committed Booking/domain events only |
| Analytics | derivations/read models | rebuild metrics, no authoritative Booking write | scoped event projections |

**Предложенный dependency rule:** `packages/domain/booking` зависит от интерфейсов Availability, Pricing, Authorization, Entitlement и Transaction; другие модули не импортируют внутренние ORM/repositories Booking. Kernel содержит contract/lifecycle/registry, но не сущности Booking/Customer/Subscription. Версионирование публичных портов обязательно; disabled optional addon не делает ядро недоступным.

**Сложность:** атомарное создание Booking при участии Pricing/Redemption/Outbox требует одного transaction context с контролируемыми межмодульными портами. Полное «каждый модуль только своя БД» **не** является правилом F1; общий Postgres допустим при четко определённом доступе к таблицам. Нет внешнего сетевого вызова внутри транзакции.

## 2. Booking: state machine (предложенная конкретизация)

```text
                     ┌─> CancelledByClient
CreateBooking ──> Confirmed ──┼─> CancelledByBusiness
                     ├─> Completed
                     └─> NoShow
```

- `CreateBooking` создаёт **сразу Confirmed** только после server availability/auth/tier and successful commit (DEC-043). Не добавлять обязательный Pending/ManualApproval.
- `RescheduleBooking` **не создаёт вторую Booking** и не меняет статус Confirmed: обновляет время и occupancy в одной транзакции, сохраняет service/staff/location, PriceSnapshot и коммерческий промокод (DEC-070). Проигранная гонка оставляет прежнюю Booking.
- `CancelBooking` из Confirmed переводит в один из двух Cancelled statuses; освобождает занятость и выполняет восстановление прав одноразовых промокодов строго в той же транзакции по принятым правилам. Идемпотентный повтор отмены не создаёт повторное восстановление.
- `Completed` и `NoShow` — terminal visit outcomes; конкретные deadlines переходов, действия сотрудников и исправление ошибочных исходов — **OPEN F1 implementation review**, не придумывать право клиента переводить их.
- Изменение услуги, мастера либо филиала — **Cancel + CreateBooking**, не «перенос»; после истечения trial CreateBooking запрещён (DEC-072/105). Перед Cancel показать, что новая запись может быть недоступна.
- Изменение графика, затрагивающее существующую Confirmed, **отклоняется** либо оформляется в ожидающую заявку на согласование, не удаляет бронь. Owner выбирает режим self-edit / approval-required; оба используют одну проверку конфликтов (REQ-028).
- «Отложенное подтверждение» или «hold» в стандартном create path не используются; future extras требуют отдельного контракта TTL.

### DB constraint и lock discipline (проверить в реальном PostgreSQL)

```sql
-- СХЕМАТИЧЕСКИЙ DDL: не запускаемый production migration.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE booking
  ADD CONSTRAINT booking_no_staff_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    staff_id WITH =,
    tstzrange(start_at, occupied_until, '[)') WITH &&
  )
  WHERE (status = 'Confirmed');
```

`start_at < end_at <= occupied_until`; `occupied_until = end_at + post_service_buffer`, если буфер применим. Правило по `tenant_id + staff_id` (без `location_id`) защищает одного StaffProfile в разных филиалах Organization. `EXCLUDE` защищает только активное состояние; если добавятся другие «занимающие» статусы, constraint менять с миграцией и regression tests.

**Lock order:** `tenant/entitlement snapshot -> staff row -> schedule version -> Booking/idempotency resources -> pricing/promo redemption -> outbox` — только рекомендуемый порядок. Для `Reschedule`, `Create`, `ScheduleChange`, `PublishStaff` нужен общий доказанный порядок, иначе возможны дедлоки. Если технически невозможно одновременно блокировать всё в этом порядке, выбирать документированную замену (например, canonical staff advisory lock + unique idempotency) и тестировать deadlock/retry. **Не считать эту последовательность доказанно deadlock-free без integration tests.**

**Idempotency:** unique key = tenantId + operation + verified actor/guest scope + caller key, request hash сохраняется; reuse того же ключа с другим payload → 409, повтор оригинального → идентичный committed результат. После uncertain network response клиент повторяет запрос с тем же ключом. Уведомления — `at-least-once` delivery с `eventId + providerId` dedup best effort, а не ложное обещание «exactly once» внешнего Telegram/SMS.

**Promo+payments:** первоначальный Quote — не источник истины после изменений каталога/скидок; стоимость подтверждается актуальным серверным расчётом на Create и фиксируется PriceSnapshot. Округлять после последовательных скидок по DEC-059/061/063/064, до нуля снизу, расходовать одноразовый промокод только если применён фактический положительный вычет DEC-066; отмена восстанавливает право в рамках исходных условий DEC-068. Не использовать JS float для денег. Контракт Decimal scale/rounding нужен при F1/F2 реализации, не выдавать за принятое SQL migration.

## 3. Матрица состояний Subscription и staff capacity

| Tenant state | CreateBooking | Читать/обслуживать прежние Confirmed | Export | Publish нового bookable staff |
|---|---|---|---|---|
| `trial_active` | Да, если permission/slot, без нового paid consent | Да | Да | По пилотной политике (отдельно решить вместимость trial); не делать автоматический paid upgrade |
| `trial_expired_unpaid` | **Нет** (web/Telegram/admin/API) | **Да**, с теми же actor/cutoff правилами | Да, owner scoped | Нет, если приводит к новым записям |
| `paid_active` | Да, Booking коммерчески без квоты | Да | Да | Да до оплаченного числа unique bookable мастеров |
| `paid_inactive` | **Нет**, если нет иного действующего права | Да по ранее Confirmed | Да | Нет до подтверждённого права |
| `tenant_suspended_security` | **Открыто**: emergency deny в случае атак/законного основания | Безопасный аварийный read/export support workflow, не обещать при компрометации | Открыто | Нет |

**ACCEPTED business:** 30 календарных дней начинаются с успешной регистрации Organization; offer ДО неё. По окончании нет нового Create без добровольной оплаты. Существующие Confirmed/экспорт не блокируются (DEC-105). Межфилиальный мастер учитывается один раз, архивные/admin-only не учитываются (DEC-109), профиль добавляется при заполненном tier, публикация требует добровольный upgrade (DEC-111).

**PROPOSED policy:**
- Определять оплачиваемый seat как уникальный StaffProfile в Organization со статусом `active && publishedForBooking && enabledClientService` хотя бы в одном Location, вне зависимости от наличия свободных слотов завтра. Архив и admin-only не считаются; отпуск без снятия публикации **не** даёт автоматический бесплатный seat. При наличии будущих Confirmed не разрешать бесконтрольную архивацию: сначала явная процедура обслуживания/отмены с уведомлением, потому что менять staff на существующей Booking нельзя.
- Для первого trial пробовать UX до покупки, но не разрешать обход роста команды через второй tenant с той же реальной организацией: антиабуз дополняет, но не меняет обязательный старт при регистрации. Конкретные trial-capacity ограничения **не утверждены** — не назначать их молча.
- Trial end предложен как `trialStartAt + 30 calendar dates` в фиксированном IANA timezone Organization, тот же local clock time, `endAt` exclusive; UTC instants в БД. DST gap/fold disambiguation и изменение org timezone — отдельные протестированные rules; считать UTC `start+720h` без проверки семантики нельзя.
- Не терять управление существующей бронью после trial expiry: client verification продолжается, но **новое бронирование из отменённой** отказывает; time-only Reschedule не является Create. Продолжать отправлять уже обещанные **транзакционные подтверждения изменений и отмен** по ранее существующим броням, если канал/согласия/договор/расходы доступны. Без бесплатного гарантированного внешнего SMS: при недоставке — in-app status и audit, ручной fallback.
- **Retention:** никаких автоматических удалений из-за конца 30 дней, пока договор/сроки/основания не прошли legal review. Временный технический план (backup, limited read/export, revoke secrets) не равен юридически обязательному сроку хранения.
- Клиент не покупает ничего в Booking flow: license payment салона — отдельное owner-privileged действие, требующее отдельного подтверждения и доказанного действующего entitlement. Версию персонального оффера и добровольное paid consent аудитировать отдельно.

## 4. AuthZ и privacy guards (применимы ко всем каналам)

1. TenantId/IdentityId берутся из доверенного session/JWT/guest proof, **не** из произвольного JSON. Любой `bookingId, customerId, staffId, locationId` повторно проверяется по принадлежности tenant.
2. Permission union допустим только для выданных активных scoped roles, а сверх union применяются **non-delegable ограничения**, например revoke Owner, transfer ownership, export all Customers, и запрет staff читать чужую CRM; при сомнении `deny`.
3. Telegram `initData` проходит server verification, `auth_date` и replay window; bot webhook/token не передаёт автоматически авторизацию другого tenant. Нельзя связывать клиентов по совпадающему имени, непроверенному телефону или username.
4. Guest management — привязанная к конкретной Booking и разрешённой операции signed/opaque capability с TTL и single-use semantics либо verified OTP, защита от enumeration, replay, brute force, revoked/expired link, логирование без токенов и ПДн.
5. Field-level данные клиента (телефон, история, заметки) доступны мастеру только в принятой модели «свои клиенты» с отдельными включёнными permission flags. Экспорт и background jobs — тоже scoped.
6. TLS, secrets/env, structured logs без session/token/телефона, audit failed access attempts, admin operations и role changes. Кросс-tenant доступ проверять отрицательными тестами даже если UI скрывает записи.
7. **Юридический gate РФ:** до реальных ПДн отдельно подтвердить роли оператора/обработчика, локализацию, основания/политики/уведомления надзорного органа при применимости, договоры сторонних коммуникаций и сроки хранения/экспорта. Этот документ **не юридическое заключение**.

## 5. Неподменяемые критерии реализации

- Ни при каком race, iframe callback или повторном Telegram webhook нельзя подтвердить два конфликтующих Booking одного StaffProfile по разным Locations.
- Ни при каком trial expiry нельзя блокировать чтение/разрешённую отмену/перенос Confirmed только из-за неоплаты; финансовые обязательства должны быть отделены от сохранения данных клиента.
- Ни при какой роли и запросе не допускается cross-tenant CRM leak; реальная проверка — integration tests, не матрица на бумаге.
- Ни при каком post-trial `CreateBooking` не должен проходить через ручной кабинет, bot, REST, batch/import или старый callback.
- Ни при каком добавлении staff в справочник Cookie автоматически не повышает тариф и не списывает деньги.
- Не объявлять выполнение этих критериев без программных тестов на F1, а юридическое соответствие — без legal review перед пилотом.

## 6. Evidence/links
- [Отдельный обязательный тест-каталог](../quality/f1-pilot-acceptance-cases.md).
- [Runbooks и risk gates](../operations/pilot-operational-readiness.md).
- [Пакет владельцу](../decisions/f0-owner-review-package-20261114.md).
- PostgreSQL official [range constraints / GiST exclusion / btree_gist](https://www.postgresql.org/docs/current/rangetypes.html).
