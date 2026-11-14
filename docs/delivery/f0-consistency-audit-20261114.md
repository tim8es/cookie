# Финальный документальный аудит F0 Cookie — 14.11.2026

**Объект:** [Draft PR #43](https://github.com/tim8es/cookie/pull/43), ветка `docs/product-foundation-20261113`, GitHub Issues #8–#15 и связанные #20/#21/#26/#29/#30/#35/#37–#39.  
**Тип:** документальный consistency/completeness/readiness review; **не** code/security/legal/performance audit.
**Вердикт, обновлён 14.11.2026:** **F0 DOCS PREPARED FOR SINGLE OWNER REVIEW; F0 Gate BLOCKED**. Архитектурные рекомендации, screen map, traceability 67 REQ, 41 негативный/приёмочный сценарий, operations runbooks и competitor/economics model созданы. **Не выполнено:** owner approval ADR/PR, реальные тесты, юридическая проверка и коммерческие измерения. См. [сводное F0 closure review](f0-closure-review-20261114.md). Этот аудит не разрешает coding, merge и реальные ПДн/оплаты.

## 1. Как проверяли

- Сопоставлены README и карта документов, [PRD](../product/requirements.md), [реестр решений](../decisions/register.md), [видение](../product/vision.md), [сценарии](../product/journeys.md), [каталог модулей](../product/module-catalog.md), [бизнес-модель](../product/business-model.md).
- Проверены ADR-0001–0007, архитектурные документы `system.md`, `modules.md`, `data-and-booking.md`, `organization-location-and-access.md`, `tech-stack.md`, [security-and-privacy](../operations/security-and-privacy.md), [deployment](../operations/deployment.md), [test-strategy](../quality/test-strategy.md), [roadmap](roadmap.md), [risk register](risk-register.md), [backlog](backlog-index.md), [workflow](workflow.md).
- Связаны требования ↔ принятые решения ↔ ADR ↔ этапы F0/F1/F2/F3 ↔ актуальные GitHub Issues #8–#15, проверен состав GitHub PR относительно `main`.
- **Проверена нумерация:** REQ-001–REQ-067 (67 записей, без дублей/пропусков), DEC-001–DEC-114 (114 записей, без дублей/пропусков).
- Проверены относительные Markdown-ссылки документов по известному дереву; к моменту завершения аудита новый отчёт добавлен в навигацию. Это **структурная** проверка, не гарантия корректности каждого внешнего сайта или anchor.
- По GitHub на момент проверки **#8–#15 открыты**; в этих восьми задачах после документального hardening **16 чекбоксов отмечены как выполненная подготовка документов, 14 остаются открытыми** (проверено после обновления Issues 14.11.2026). Часть требований уже содержится в документах; отсутствие галочки не доказывает полного отсутствия работы, но отсутствие формального sign-off очевидно.
- В PR документальная ветка опережает `main`; сравнение показывает документы, шаблоны и инструкцию AGENTS, не производственный код. **Тестовый прогон продукта не выполнялся: приложения F1/F2 ещё нет.**

## 2. Что согласовано (ACCEPTED) и не должно теряться при закрытии F0

| Область | Принятое направление | Основное основание |
|---|---|---|
| Архитектура | minimal plugin kernel, модульный монолит, независимый Booking API, без hot-install произвольного кода; tenant entitlement для установленных функций без перезапуска | ADR-0001, DEC-093/095 |
| Booking | одна услуга и один мастер на Booking; автоматическое Confirmed; отсутствие double booking; один master между филиалами без пересечений | ADR-0003, REQ-021/024/029, DEC-041/043 |
| Клиентский вход и права | телефон либо Telegram; единая Organization CRM, multi-location, scoped roles, мастер видит только связанных с его записями клиентов и отдельные поля по permission | ADR-0004, REQ-020/024/026/027 |
| Графики | владелец выбирает self-edit или approval-required, без автоматического разрушения Confirmed | REQ-028, organization-location-and-access |
| Коммерческий пилот | минимальный web booking + business calendar + **сценарный Telegram без AI** + уведомления; 30 календарных дней с успешной регистрации Organization; платный переход только по отдельному явному согласию | DEC-095/097/099/101/103 |
| После trial | без оплаты не создавать новые Booking через web/Telegram/admin/API; существующие Confirmed доступны для разрешённого управления и экспорта; нет автосписания | DEC-105 / REQ-063 |
| Тарифная структура | tiers по числу **уникальных действующих мастеров, доступных для записи**, в нескольких филиалах мастер считается один раз; без тарифицируемого лимита Booking | DEC-107/109, REQ-064/065 |
| Превышение tier | StaffProfile можно завести в справочник, но активация мастера сверх tier только после добровольного upgrade; не затрагивать текущие записи | DEC-111 / REQ-066 |
| **Q46 (новое)** | **первым салонам индивидуальные коммерческие офферы, согласованные ДО регистрации/начала trial; публичный прайс позже**; согласование предложения **не** равно разрешению автоматически списывать | **DEC-113 / REQ-067 ACCEPTED; DEC-114 PROPOSED** |

Подробные алгоритмы скидок (порядок, half-even, ноль, расходование одноразовых кодов, tie-break, price snapshot) подробно фиксированы в [PRD](../product/requirements.md), ADR-0003 и test-strategy. Не переоткрывать подтверждённые продуктовые развилки из-за нерешённого технического формата.

## 3. F0 blockers / замечания

| ID / серьёзность | Конкретный пробел | Последствие и условие закрытия | GitHub |
|---|---|---|---|
| **F0-B01 · P0/owner** | **DOC PREPARED:** ADR-0001 и [domain contracts](../architecture/f0-contracts-and-invariants.md) описывают minimal kernel, public ports, lifecycle и data ownership; точный код/контракты ещё не исполнялись | **Owner review** F0-P04; в F1 проверить выключение optional модулей и запрет internal imports. Не считать status ADR ACCEPTED до подписи. | [#9](https://github.com/tim8es/cookie/issues/9) |
| **F0-B02 · P0/owner** | **DOC PREPARED:** Node.js 26 LTS/TS+Fastify и Svelte 5/Vite static предложены с Go/React/SSR альтернативами, CI/layout/worker strategy в [F0-P01..03](../decisions/f0-owner-review-package-20261114.md) | **Owner review** default; реальные resource/mobile performance measurements, зависимостные версии — F1, не имитировать уже проведённый benchmark | [#10](https://github.com/tim8es/cookie/issues/10) |
| **F0-B03 · P0/owner** | **DOC PREPARED:** [Booking state machine, staff lock, GiST exclusion, idempotency/outbox](../architecture/f0-contracts-and-invariants.md) и [41 negative/integration case](../quality/f1-pilot-acceptance-cases.md) | **Owner review** технического контракта; затем actual Postgres SQL/locking/concurrency evidence в F1, а не в F0 | [#11](https://github.com/tim8es/cookie/issues/11) |
| **F0-B04 · P0/owner + legal prepilot** | **DOC PREPARED:** scoped authZ matrix, hard protected rights, Telegram/guest/phone identity, [operation runbooks](../operations/pilot-operational-readiness.md) | **Owner review** допущений, F1 negative tests; реальные ПДн/договоры, legal review и retention — **обязательный pre-real-pilot gate** | [#12](https://github.com/tim8es/cookie/issues/12) |
| **F0-B05 · P0/owner** | **DOC PREPARED:** общий web/iframe/Telegram [screen map](../architecture/f0-implementation-blueprint.md), failures/empty states и критерии mobile/accessibility; макеты и измерения не готовы | **Owner review** UI static/SSR и карты экрана; real device usability/performance — F1/Pilot тесты, не отмечать done в F0 | [#13](https://github.com/tim8es/cookie/issues/13) |
| **F0-B06 · P0/GTM evidence** | **DOC PREPARED:** [точечная матрица четырёх конкурентов с оговорёнными расхождениями и model 10/50/200](../product/market-economics-validation.md); [индивидуальный pilot playbook](../product/pilot-commercial-playbook.md). **НЕТ** фактических интервью, оплат, unit economics, license/legal/provider evidence | Для F0: **owner review** модели и разрешённого переноса market proof; реальные цены, provider/legal/РФ ПДн и платёжная готовность — pre-real-pilot, не объявлять закрытыми | [#14](https://github.com/tim8es/cookie/issues/14) |
| **F0-B07 · P0/traceability** | **DOC PREPARED:** [матрица всех REQ-001–067](requirements-traceability-f0.md), F1 vs pilot vs full F2; acceptance cases в [41-сценарном плане](../quality/f1-pilot-acceptance-cases.md). Полного REQ→реальный CI test mapping ещё нет | **Owner review** phase mapping; доказательства actual testing и конкретные CI IDs только после F1 coding. Нельзя требовать полную F2 готовность для первого ограниченного pilot | [#8](https://github.com/tim8es/cookie/issues/8) |
| **F0-B08 · P0/governance** | PR #43 **open, без подтверждённого owner approval/merge**, задача #15 open; из текста PR не следует, что зависимости #8–#14 выполнены | Выполнить review, закрыть блокеры/зафиксировать явные допущения, обновить статусы ADR/Issues; только владелец может утвердить F0, затем merge и отдельно дать команду на F1 coding | [#15](https://github.com/tim8es/cookie/issues/15) |

**Не маркировать все PROPOSED как ошибка:** для реализации схем, провайдеров, точных полей и инженерных benchmarks допустим осознанный F1 review. Но критические границы и архитектурные критерии должны быть документально приняты либо владельцем явно признаны допустимыми non-blockers, а не оставлены неопределёнными при проходе F0 Gate.

## 4. Отдельные блокеры первого РЕАЛЬНОГО коммерческого пилота (не путать с F0)

Эти пункты могут быть отложены относительно документационного F0 **только явно**, но обязательны до работы с настоящими клиентами и сбора ПДн.

1. **Законность и эксплуатация:** регламент обработки ПДн, роли SaaS оператора/обработчика и салона, место хранения/обработки данных, политика экспорта/удаления и backup/restore; проверить внешние Telegram/SMS провайдеры. См. [security-and-privacy](../operations/security-and-privacy.md), [deployment](../operations/deployment.md), [#37](https://github.com/tim8es/cookie/issues/37).
2. **Trial lifecycle:** согласовать серверное вычисление срока в 30 календарных дней (start при успешной регистрации уже ACCEPTED), момент cutoff/timezone и гонки, анти-abuse/повторные аккаунты, доступ и срок хранения после отказа; текущие Confirmed можно обслуживать/изменять/экспортировать (DEC-100/102/104/105/106).
3. **Paid/licensing:** индивидуальный оффер конкретного салона **до регистрации** (DEC-113), договор/платёжный процесс, документированное ознакомление, **отдельный добровольный opt-in после trial**, надёжная тарифная entitlement модель, upgrade без auto-charge, отсутствие booking quota (DEC-107–114). До реального оффера должны быть известны **именно данному салону** цена и период, хотя общего прайса пока нет.
4. **Delivery readiness:** end-to-end успешная web и Telegram бронь через один Booking API, anti-double booking concurrency tests, подтверждение/outbox/retry, безопасность, восстановление данных, диагностируемые уведомления; отдельный pilot gate в [roadmap](roadmap.md), [#29](https://github.com/tim8es/cookie/issues/29), [#30](https://github.com/tim8es/cookie/issues/30), [#38](https://github.com/tim8es/cookie/issues/38).
5. **Коммерческие метрики:** приглашённые / зарегистрированные / настроившие каталог / получившие реальные брони / получившие индивидуальное предложение / давшие отдельный paid opt-in / **действительно оплатившие**. Не смешивать с положительными интервью и не объявлять экономику доказанной до данных.

## 5. Исправления в рамках текущего прохода аудита

- DEC-113/REQ-067 добавлены как ACCEPTED, DEC-114 как PROPOSED; обновлены бизнес-модель, roadmap, journeys, test-strategy, risk-register, operations и коммерческие Issues.
- Исправлена устаревшая формулировка видения **«график обязательно согласует администратор»**: по действующему решению владелец выбирает self-edit или approval.
- В каталог модулей добавлена необходимая для пилотного биллинга Subscription/Entitlements capability с разделением ACCEPTED product и PROPOSED implementation.
- Уточнён договорно-эксплуатационный раздел deployment для индивидуальных офферов и окончания 30-дневного теста.
- Актуализирована карта документов и ссылка на этот аудиторский отчёт.
- Текущая структура PRD и decision register проверена на отсутствие пропусков и повторов ID. Это **не** равнозначно 100% REQ↔test traceability.

## 6. Gate-вердикты

| Gate | Вердикт | Основание |
|---|---|---|
| Продуктовое интервью через Q46 | **Завершён запланированный раунд** | DEC-001–114, REQ-001–067, приняты Q37–46 |
| Документальное наполнение F0 | **PREPARED FOR OWNER REVIEW** | Уточнены контракты, матрица 67 REQ, 41 test cases, мониторинг/retention gates и конкурентный benchmark; проверка owner pending |
| Consistency audit как действие | **Выполнен документально** | Этот отчёт и сверка GitHub Issues / PR; остаются перечисленные несогласованности |
| F0 Gate / owner approval | **BLOCKED / не получен** | #8–#15 открыты; ADR-0001–0005 не финализированы, часть критериев #14/#13 не закрыта, PR не merged |
| Старт F1 coding / CI / инфраструктуры | **NOT AUTHORIZED** | Только после явного F0 approval, review+merge и отдельной команды владельца |
| Реальный пилот с данными клиентов / оплата | **NOT READY** | #37/#38/#39 и все safety/commercial readiness из раздела 4 |

## 7. Порядок закрытия (без нового марафона продуктовых вопросов)

1. **#8 → #9:** сначала утвердить scope/traceability PRD, затем минимальные kernel contracts — это явная зависимость в GitHub Issues.
2. **#10/#11/#12 → #13; #14 после #8:** документально зафиксировать условный tech stack, transaction boundary и identity/permission safety, затем screen map/shared UI; отдельно — сравнительный коммерческий benchmark/unit economics. Детали реализации можно осознанно оставить для F1, но не выносить за gate критичные гарантии.
3. **#15:** провести owner-review по конкретным блокерам, обновить чек-листы и статусы ADR, восстановить PR readiness. Не закрывать Issue до реального review/approval.
4. **После явного одобрения:** merge F0 и отдельно команда на F1. На F1 — реализация с тестами, не поставка реального пилота до security/operational/business gates.

**Важно:** это финальный аудит текущего состояния документации, **не финальное утверждение F0**. Ответа «да, всё готово к coding» оснований нет. Все неопределённые коммерческие суммы/тарифные пороги и техника платёжного согласия остаются в статусе OPEN/PROPOSED; пользователь не утверждал их ответом на Q46.

## 8. Обновление после подготовки пакета owner-review (2026-11-14)

**По новому запросу владельца** отдельные технические вопросы заменены одним пакетом рекомендуемых решений без автоматического присвоения ACCEPTED. Сформированы и доступны в ветке:

1. [Пакет F0-P01..P12 для единого рассмотрения](../decisions/f0-owner-review-package-20261114.md) — стек, архитектура, Booking, AuthZ, screen map, trial/tier, пилотный scope, gates.
2. [Детальный implementation blueprint](../architecture/f0-implementation-blueprint.md) — module boundary, API commands, PostgreSQL transaction/range exclusion, authZ matrix, UX карта экранов, порядок выполнения.
3. [Сквозная traceability REQ-001–REQ-067](requirements-traceability-f0.md) — **67/67 индексированных** требований с фазой, ожидаемым поведением и ответственными GitHub Issues; конкретные автоматические tests F1 ещё не пройдены.
4. [Commercial pilot playbook](../product/pilot-commercial-playbook.md) — персональный оффер до регистрации, добровольное платное продолжение, post-trial restriction, unit economics **как модель**, не подтверждённые расчёты.
5. ADR-0001–0005, tech-stack, system/modules, roadmap/README и workflow дополнены ссылками на предложенные значения и критериям отклонения; **status ADR остаётся PROPOSED** до owner review.

**Что это меняет:** документальные рекомендации по F0-B01..F0-B07 теперь **сформулированы для единоразового рассмотрения**, а не оставлены вопросами интервью. Это снижает работу владельца, но **не доказывает** фактическую performance/UX/security/экономику, не является юридической проверкой и **не закрывает F0 Gate**.

**Что осталось для подписи владельца, без новых микровопросов:**
- Проверить за один проход весь [пакет F0-P01..P12](../decisions/f0-owner-review-package-20261114.md) и либо утвердить, либо перечислить конкретные исключения. Только после этого обновлять ADR-0001–0005 с PROPOSED на ACCEPTED.
- Для раннего F1 одобрить план технических тестов DB concurrency, authZ и один UI stack; детали зависимостей/DDL реализовать в F1 и покрыть тестами, **не обещая уже измеренных результатов**.
- Коммерческие юридические документы, реальная unit economics, реальные офферы и РФ ПДн вынести в обязательный **pre-real-pilot gate**, не требуя подтверждённых продаж до внутреннего F1, если owner осознанно согласовал такую фазировку.
- **Issue #15, PR #43, F0 Gate, F1 coding approval остаются НЕ ЗАКРЫТЫ/НЕ ПОЛУЧЕНЫ** на момент этого дополнения. Не merge, не менять branch status и не включать live billing.

**Уточнённый статус:** пакет **готов к владельческому ревью по содержанию**; F0 Gate всё ещё **BLOCKED** до принятия пакета и документального подтверждения обязательных требований. Это два разных статуса, их нельзя смешивать.

## 9. Завершение документального hardening (2026-11-14)

После первого аудита созданы и связаны: [доменные контракты](../architecture/f0-contracts-and-invariants.md), [41 сценарий приемки](../quality/f1-pilot-acceptance-cases.md), [операционная готовность](../operations/pilot-operational-readiness.md), [обновлённое рыночное сравнение и economics model](../product/market-economics-validation.md) и [одностраничный closure review](f0-closure-review-20261114.md). **Строки F0-B01..B07 выше обновлены:** это теперь подготовленные документы с открытым owner sign-off/implementation evidence, а не отсутствующие материалы. 

Официальные источники показали расхождение по бесплатным встречам Планёрки: на /prices ещё 20, в обновлении 6 ноября 2026 стало 10; исправлено в бизнес-модели. BookNow на одной pricing-странице противоречит себе по auto-renewal; никаких выводов об автоматическом списании от имени конкурента не делаем. Это не отменяет **ACCEPTED DEC-105**, в Cookie paid-only new bookings после trial.

**Итог:** структура F0 **готова к одному owner-review**, но F0 approval, PR merge и F1 кодирование **не разрешены**. Тесты/бэкапы/юридический review/платёжные конверсии и реальные цены **не произошли**.

## 10. Решение владельца — 2026-11-14 (новее исторических gate статусных строк)

Владелец **утвердил F0-P01–F0-P12 и разрешил F1 инженерный bootstrap** (DEC-115). ADR-0001–0005 статус ACCEPTED на уровне baseline; blocker sign-off F0 снят владельцем. Документационный PR #43 требуется подготовить к слиянию по правилам repo и нельзя считать merged до подтверждения. Открытые тесты Postgres concurrency, security, mobile UX и реальные ПДн/договоры/экономика перенесены в обязательные gates F1/пилота; без фактического испытания не объявлять PASS. Режим «F0 Gate BLOCKED» в старом аудите относится к состоянию **до явного решения владельца**.
