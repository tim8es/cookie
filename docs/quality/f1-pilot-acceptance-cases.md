# F1 / пилот — каталог негативных и acceptance тестов

**Статус:** PROPOSED test plan; **НИ ОДИН тест не отмечен пройденным**. Источники: [PRD REQ-001–067](../product/requirements.md), [F0 технические контракты](../architecture/f0-contracts-and-invariants.md), [существующая test-strategy](test-strategy.md), [roadmap](../delivery/roadmap.md). Тесты применяются в соответствующей фазе: F1 internal ≠ разрешение real pilot.

**Execution guidance:** TypeScript unit/contract tests + PostgreSQL integration suite для конкурентных инвариантов + Playwright для web + simulated Telegram/webhook tests + controlled staging restore; negative security tests обязательны. Измерять actual runtime и внешнюю доставку, не выдавать мок за доказательство production provider. Для P0 `pass` означает реальный артефакт теста/log/trace и отсутствие known critical defects.

## Core booking / Postgres

| ID | Given/When | Expected evidence | Gate | Issue |
|---|---|---|---|---|
| BOOK-01 | Два одновременных CreateBooking одного StaffProfile/slot в одной Location | Exactly 1 Confirmed, второй BOOKING_CONFLICT, DB exclusion proof; committed snapshot untouched | F1 / P0 | #11/#21 |
| BOOK-02 | Разные Location с тем же StaffProfile, overlapping occupied ranges | Ровно 1 Confirmed; locationId не позволяет обойти staff-wide constraint | F1 / P0 | #11/#21 |
| BOOK-03 | Соседние интервалы [startAt, occupiedUntil) без пересечения | Оба допустимы; post-service buffer входит в занятость | F1 / P0 | #11/#21 |
| BOOK-04 | Повтор CreateBooking с тем же idempotency key, тем же payload после lost response | Та же Booking/result, никаких дублей outbox или промокодов | F1 / P0 | #11/#21 |
| BOOK-05 | Тот же key с другим payload или actor scope | Предсказуемый conflict/deny, без изменения данных | F1 / P0 | #11/#21 |
| BOOK-06 | ScheduleChange против Create/Reschedule параллельно | Сериализованное валидное состояние; Existing Confirmed не отменяется; deadlock/retry bounded | F1 / P0 | #11/#20/#21 |
| BOOK-07 | Reschedule в уже занятый слот | Ошибка и прежняя Confirmed с тем же price/discount snapshots | F1 / P0 | #11/#21 |
| BOOK-08 | Изменить услугу/мастера/Location у действующей Booking | Только Cancel+new Create; недопустим direct mutation Booking | F2 / P0 | #25/#21 |
| BOOK-09 | Cancel Confirmed, затем retry, затем восстановление одноразового промокода | Redemption восстановлен только один раз при успешной отмене; expired code не становится valid | F2 / P0 | #21/#28 |
| BOOK-10 | Сквозной web→Telegram→admin просмотр одной Booking | Одна booking ID/price/state, без дублирования каналами | Pilot / P0 | #23/#29 |
| BOOK-11 | DST fold/gap в timezone Location, конверсия в UTC | Никакой двусмысленной брони/локального времени; IANA и явная политика выбора | F1 / P1 | #11/#21 |
| BOOK-12 | Отказ external notifier после Booking commit | Booking остаётся Confirmed, outbox pending/retry/audit, нет ложного failed booking | Pilot / P0 | #30/#38 |

## Entitlement / billing

| ID | Given/When | Expected evidence | Gate | Issue |
|---|---|---|---|---|
| BILL-01 | Регистрация Organization после ознакомления с индивидуальным оффером | trial starts once immediately; offer version/time precede creation; onboarding consumes days | Pilot / P0 | #35/#39 |
| BILL-02 | Регистрация user account без Organization | 30-day trial Organization ещё не начался | Pilot / P1 | #35 |
| BILL-03 | Повторное создание Organization по сетевому retry/идемпотентному key | Не выдаёт новый старт в той же tenant; anti-abuse отдельных юрлиц на review | Pilot / P0 | #35 |
| BILL-04 | Граница trial expiry, конкурентный Create, callbacks из web/TG/admin/API | Новые Booking с commit после server cutoff блокируются всеми каналами; fail closed | Pilot / P0 | #35/#21 |
| BILL-05 | Trial expired, есть будущая Confirmed клиента | Клиент может разрешённо читать/reschedule time-only/cancel; владелец — export | Pilot / P0 | #35/#25 |
| BILL-06 | Trial expired, Cancel+Create для смены мастера | Cancel по прежним правилам, предупреждение, новый Create отклонён | Pilot / P0 | #35/#25 |
| BILL-07 | Оффер до регистрации, отказ от paid или отсутствие платёжного подтверждения | Нет auto subscription/charge; Create закрыт после trial; данные доступны по политике | Pilot / P0 | #35/#39 |
| BILL-08 | Активный tier с большим числом корректных Booking | Нет коммерческой booking quota; технический rate limiting возможен без ложной paywall ошибки | Pilot / P0 | #35 |
| BILL-09 | Мастер назначен одновременно в 2 Location; есть admin-only и archived | Billable unique active bookable count 1 + исключённые 0; два разных одинаковых ФИО ≠ один master | Pilot / P0 | #20/#35 |
| BILL-10 | Paid capacity=5, добавить StaffProfile #6, попытаться Publish | Создать draft можно; Publish отказывает до explicit upgrade; старые 5 и Confirmed сохранены | Pilot / P0 | #20/#35 |
| BILL-11 | Два parallel Publish при одном свободном paid seat | Не больше одного нового bookable мастера; все каналы/импорт защищены | Pilot / P0 | #20/#35 |
| BILL-12 | Отпуск при сохранённой active+bookable публикации | Рекомендуемая модель seat не уменьшается; нужно acceptance owner, не выдавать тест как принятое правило | Proposed / P1 | #35 |
| BILL-13 | Завершение trial на DST или после изменения timezone Organization | По согласованной локальной calendar semantics, без скрытого продления/сокращения; точный DST disambiguation OPEN | Pilot / P0 | #35 |

## Security / privacy

| ID | Given/When | Expected evidence | Gate | Issue |
|---|---|---|---|---|
| SEC-01 | Staff одного tenant пытается читать Customer другого и чужую запись | 403/404 без PII leak в body/logs или по ID enumeration | F1 / P0 | #12/#37 |
| SEC-02 | Staff имеет только свои booking-related customers; доступ к history/notes/phone | Owner-configured field permission применяется server-side к reads/search/export | Pilot / P0 | #12/#37 |
| SEC-03 | Один Identity с ролями в разных Location/Organization | Только выданный scope на конкретный ресурс; role union без cross-tenant escalation | Pilot / P0 | #12/#37 |
| SEC-04 | Admin меняет displayName роли на «Владелец» | Non-delegable owner actions остаются запрещены | Pilot / P0 | #12/#37 |
| SEC-05 | Поддельный/просроченный Telegram initData, spoof webhook/callback | Reject до любых read/write; no leaked customer details | Pilot / P0 | #12/#29 |
| SEC-06 | Guest link revoked/expired/replayed, ID-only management | No access or state change; scoped time-limited proof required | Pilot / P0 | #12/#25 |
| SEC-07 | Tenant export в restricted posttrial режиме | Owner-scoped export без других tenants и с аудитом; безопасный download TTL | Pilot / P0 | #12/#37 |
| SEC-08 | Cookie session/Web iframe postMessage under foreign parent origin | Only allowlisted origin and typed limited payload; no token/PII in postMessage | Pilot / P0 | #13/#37 |

## Operations / UX / gates

| ID | Given/When | Expected evidence | Gate | Issue |
|---|---|---|---|---|
| OPS-01 | Worker crash before ack or after provider send | Idempotent event handling, bounded retry, poison message DLQ, no lost Booking | Pilot / P0 | #30/#38 |
| OPS-02 | Backup then restore into clean staging | Integrity/tenant isolation/price snapshots verified; record measured RPO/RTO | Pilot / P0 | #38 |
| OPS-03 | Server release with SQL migration failure | Documented rollback/roll-forward safe procedure, no partial tenant damage | Pilot / P0 | #38 |
| OPS-04 | No slots/timeout/409/expired trial/capacity full in mobile UI | Clear error and next step, no optimistic success or empty dead end | Pilot / P1 | #13/#27 |
| OPS-05 | 10–15 minute onboarding claim on target salon with 2–10 masters | Measured task duration, failure reasons; mark as target not assumed pass | Pilot / P1 | #27/#39 |
| OPS-06 | Outage monitoring/p95/job-lag/error-rate alert / incident drill | Real metric/log/trace and owner escalation, incident runbook replay proof | Pilot / P0 | #38 |
| OPS-07 | Check legal basis/hosting/data location/retention/salon consent before real test | External review record and provider contracts; no real PII until complete | Pre-real-pilot / P0 | #37/#39 |
| OPS-08 | Fail closed when entitlement/billing provider cannot confirm active paid right | No unauthorized new Booking; existing Confirmed management safe | Pilot / P0 | #35/#38 |

## Gate и критерии доказательства

- **F0 owner-review:** можно проверить только **полноту описания тестов и механизмов**, не проходные результаты. Подпись F0 не означает passing F1/pilot.
- **F1 exit:** обязательно pass все F1/P0 сценарии из этой матрицы с реальным PostgreSQL; все undecided product conflicts собраны и помечены. Не запускать реальные салоны на внутреннем F1.
- **Pilot-ready:** все Pilot/P0 + Pre-real-pilot/P0 пройдены; правовые документы, оплата, договорённости по ПДн и сохранению данных, текущий operational runbook. Scenario P1 — измерить/зафиксировать risk acceptance, не обещать автоматический pass.
- **Не хватает намеренно:** реальных нагрузочных p95/RAM/RPS цифр, точного compliance и коммерческих показателей. Их нельзя придумать в документации; owner подтверждает перенос в релевантный gate.
- Любое изменение полей тарифа/состояний/времени DST/схемы booking после approval требует regression + ADR update.

**Количество тестовых сценариев:** 41. В дальнейшем тесты должны иметь GitHub Action / CI evidence URL, дату, git SHA, Postgres version, expected/actual и статус; до начала coding это только письменный контракт.
