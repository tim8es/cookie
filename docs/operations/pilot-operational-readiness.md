# Cookie — операционная готовность F1 / первого коммерческого пилота

**Статус: PROPOSED runbook и gate checklist.** Не означает настроенный хостинг, проверенные бэкапы, выполненный аудит безопасности или готовность к приёму ПДн. Основано на [security-and-privacy](security-and-privacy.md), [deployment](deployment.md), [конкретных доменных контрактах](../architecture/f0-contracts-and-invariants.md), [тестах](../quality/f1-pilot-acceptance-cases.md), Issues #37/#38/#35.

## 1. Разделить среды и допуск

| Среда | Реальные клиенты/ПДн | Требования |
|---|---|---|
| Developer/local | Нет, только синтетические данные | branch CI, unit tests, isolated temporary PostgreSQL |
| F1 integration/staging | Нет, synthetic fixtures | реальный PostgreSQL для concurrency, migrations, fail/retry/outbox, backup/restore, simulated Telegram |
| Real pilot SaaS | Да, **только после отдельного gate** | законный hosting/локализация/платёжные договоры, consent, authZ тесты, monitor/restore/incident response, индивидуальный оффер до регистрации |

Не допускать в staging скопированные контакты настоящих салонов без отдельного согласованного основания и anonymization. Не использовать бесплатный экспериментальный хостинг как production с ПДн.

## 2. Monitoring и сигналы проблем

| Сигнал | Что наблюдать | Реакция |
|---|---|---|
| `http_request` | requestId, tenantRef, route, status, latency, auth failure, **без** текста сообщений/PII | рост 5xx или authZ errors → incident investigation; исключить raw tokens |
| `booking_command` | idempotency outcome, conflict vs invalid vs expired, transaction duration, DB exclusion violation | 2 Confirmed в одном диапазоне → SEV1, отключить unsafe write path до расследования |
| `outbox_delivery` | pending, retries, age oldest, provider rate response, dead-letter, dedup | backlog/delay → проверить провайдера/worker, не откатывать Confirmed |
| `trial_entitlement` | start/endAt, paid state, denied create attempts, upgrade consent version, capacity | несанкционированная paid activation или create after expiry → SEV1 |
| `security_access` | denied cross-tenant attempt, role changes, guest token reuse, import/export requests | suspicious cluster → revoke creds/rotate, preserve audit |
| `database_health` | replication/backups (если применимо), free disk, connection saturation, migrations | volume full → stop writes safe, investigate |
| `customer_impact` | failed real bookings, active tenants, first-booking time, real paid conversion | не использовать registrations как metric revenue |

Конкретные p95 latency, error budgets, job lag alarms и RPO/RTO **не назначены как фактические SLA**: после F1 нагрузки измерить baseline и утвердить пороги. Все audit events должны содержать timestamp, operation, correlation ID, actor scope, tenant scope, outcome, но исключать пароль/токен/телефон/содержимое диалога.

## 3. Incident severity и первичные действия (проект)

| Severity | Пример | Немедленное действие |
|---|---|---|
| **SEV1** | Возможное чтение чужих ПДн, обход entitlement к созданию новых броней, двойные Confirmed, необоснованное списание | прекратить небезопасные операции соответствующего модуля, сохранить forensic logs без новых утечек, вызвать owner/security, определить post-incident remediation/notification requirements с юристом |
| **SEV2** | Уведомления массово задержаны, web booking недоступен, worker crash с неразобранным outbox | изолировать provider/worker, сохранить Booking DB, включить безопасный fallback, приоритетно восстановить прием/обслуживание записей |
| **SEV3** | UI отображает устаревший quote, сбой non-core reporting, косметические ошибки календаря | завести issue, поставить регрессионный тест, не блокировать ядро |

**Принцип recovery:** не править вручную статусы и время существующих Confirmed ради устранения симптома. Сначала снять DB snapshot, воспроизвести инцидент на обезличенных/синтетических данных, затем rollback/forward correction миграцией с аудитом.

## 4. Типовые runbooks

### RB-01 — двойное бронирование / неверный интервал
1. Остановить unsafe Create/Reschedule/ScheduleChange write path при доказанном нарушении, не удалять уже Confirmed.
2. Собрать database constraint versions, request IDs, staff scopes/intervals, transaction outcomes; проверить tenant/Location.
3. Выявить, не отключён ли GiST exclusion (или эквивалент), совпадает ли `occupiedUntil` с post-buffer, есть ли обход через admin/bot/import.
4. Исправить код/модель, добавить доказательный concurrent test. Восстановление бронирований с салоном — отдельно, с уведомлениями клиентам.

### RB-02 — Telegram/SMS недоступны после confirmed Booking
1. Не отменять Booking из-за fail delivery; outbox остаётся pending/retry with exponential backoff и jitter.
2. Ограничить число попыток/TTL по провайдеру; после порога — dead-letter, alert, in-app status, безопасное ручное уведомление владельца без раскрытия чужих контактов.
3. После восстановления idempotent replay; возможные дубли у внешнего provider документируются, нельзя обещать exactly-once.

### RB-03 — trial истёк с будущими Confirmed
1. Установить server entitlement `trial_expired_unpaid` в момент cutoff: **все** новые CreateBooking запрещены, ручной admin/bot/API тоже.
2. Сохранить read/time-only reschedule/cancel и экспорт существующих записей с действующей identity/permission проверкой.
3. Продолжать транзакционные изменения/отмены и нужные напоминания по прежним Confirmed в рамках разрешённых каналов/договора/ресурсов (PROPOSED policy, стоимость внешних сообщений согласовать до pilot).
4. Показывать салону добровольное предложение платного перехода, **не** автосписание; не очищать БД из-за истечения trial.

### RB-04 — staff tier full / ошибочный upgrade
1. Проверить unique active bookable StaffProfile внутри Organization, multi-location — один.
2. Если вместимость исчерпана, позволить staff draft, запретить Publish, не затронуть действующих masters и Confirmed.
3. Изменять paid entitlement только при explicit owner consent + доказательстве оплаты/договора. При lost acknowledgement не создавать двойную подписку/списание.
4. Любые корректировки тарифа, downgrade и связанные с будущими Confirmed случаи — по утверждённой policy, не пытаться массово архивировать мастеров ради seat reduction.

### RB-05 — cross-tenant / compromised auth token
1. Disable affected token/session/access, escalate to incident owner; не экспортировать/включать чужие данные в алерты.
2. Зафиксировать номера операций, предел потенциальной утечки и event audit; проверить revoked session scope, membership и resource ownership, экспорт.
3. Исправление права с отрицательным тестом; notification/legal obligation по применимости/экспертизе перед возвратом в prod.

### RB-06 — миграция/DB недоступна, восстановление
1. Сверить schema version, миграционный план backwards compatibility, snapshot time и safe deploy order. Не запускать необратимую миграцию без verified backup.
2. Восстановить в **изолированную** среду с выданным минимумом полномочий, выполнить referential/financial/booking integrity validation.
3. Проверить Booking unique overlap, outbox cursor/dedup, consent records, tenant isolation, export и даты timezone.
4. Записать реальное restore duration/data window; далее выбрать RPO/RTO target на основе измерений.

## 5. Backups, restore, export, retention — предлагаемые границы

- Backup strategy: автоматические PostgreSQL snapshots/dumps в зашифрованном хранилище вне runtime, ограниченные права и периодическая восстановительная репетиция. Частота/сроки хранения/регион хранения/стоимость — после данных и legal.
- Не объявлять backup успешным, пока не проверен **restore** и читаемость tenant-scoped Booking/Offer/Audit данных.
- Export: доступ только по verified owner/специально выданному разрешению, scoped к одной Organization, short-lived download URL, audit, минимизация PII. Экспорт доступен также в `trial_expired_unpaid`.
- Retention: **юридически утверждённый policy отсутствует**. Не назначать самовольно 30/90/365 дней; GDPR или другие нерелевантные сроки не подменяют российские обязанности. До реального пилота ответственный определяет категории (контакты, история Booking, audit, backup), основания, сроки, deletion workflow и работу с действующими будущими Confirmed.
- Уведомления о будущем визите после trial: бизнес-правило обслуживания старых Confirmed принято, но стоимость внешних SMS и доступ к платному каналу — отдельный договорный риск. Предложение — сохранить безопасный канал уведомлений об отмене/переносе и понятный manual fallback.

## 6. Пакет перед первым реальным салоном

- [ ] Законные договоры и ПДн РФ: процесс обработки и хранение, корректный регион/провайдер, субъект, сроки, роли, DPA/согласия и обязанности по уведомлению при применимости — юр./security review.
- [ ] Индивидуальный offer (tier/цена/период/после trial) принят до регистрации; отдельный способ фиксации добровольного paid opt-in, никакой автосписанной подписки.
- [ ] Backup и restore dry-run с actual logs; authZ/cross-tenant security tests; Booking race tests; posttrial+staff capacity tests.
- [ ] Алерты/он-call роли/связь салона с поддержкой и escalation runbooks, запрет raw PII в логах.
- [ ] Реальная стоимость инфраструктуры/уведомлений при 10/50/200 салонах и отдельная economics/price decision.
- [ ] Согласованная policy на долгосрочное сохранение/экспорт/удаление данных, в том числе после nonpayment; нет скрытого удаления Confirmed.
- [ ] Текущие коммерческие API/провайдеры/сторонние каналы имеют законное разрешение и проверенные условия использования.

**Gate result:** пока **NOT READY FOR REAL CUSTOMER DATA** — это документальный контрольный список, а не отметка об успешной эксплуатации.
