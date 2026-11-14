# Cookie F0 — пакет рекомендуемых решений на единое ревью

**Дата:** 2026-11-14. **Статус:** **PROPOSED FOR OWNER REVIEW** — рекомендации архитектора/продакт-аналитика, не принятые от имени владельца. **Фаза:** F0, документация; не означает approval на код, merge, деплой, реальные персональные данные или оплату.

## Контекст и правило приоритета

Источники уже принятых правил: [реестр DEC-001–114](register.md), [PRD REQ-001–067](../product/requirements.md), [финальный F0 аудит](../delivery/f0-consistency-audit-20261114.md), [задачи #8–#15](https://github.com/tim8es/cookie/issues/15).

**Любое ACCEPTED решение владельца выше по приоритету, чем предложения этого пакета**. Не подменять продуктовый контракт ради простоты реализации. Отсутствующий коммерческий/правовой факт — не разрешение придумать его. Всё ниже можно принять одним ревью с замечаниями, вместо 20 отдельных интервью.

## Предлагаемые F0-технические решения — одно согласование

| Код | Предлагаемый default | Почему и критерий пересмотра | Связанная задача |
|---|---|---|---|
| **F0-P01** | **Backend: Node.js 26 LTS + TypeScript + Fastify**; единый модульный монолит и отдельный worker process из той же кодовой базы | Минимум смены языка и инструментов, проще поддерживать solo с Codex, много интеграций; **пересмотреть в пользу Go**, если на эквивалентном F1 spike Node заметно не укладывается в измеренную экономику RAM/latency либо event-loop мешает | #10 / ADR-0002 |
| **F0-P02** | **Frontend: Svelte 5 + Vite, статический SPA**, отдельные адаптеры оболочек public web / iframe / Telegram Mini App, общий Booking UI | Не вводить SSR-слой/второй сервер без доказанной SEO-нужды; React остаётся резервом при реальном дефиците качественной календарной/a11y-библиотеки или UX-производительности | #10, #13 / ADR-0005 |
| **F0-P03** | **PostgreSQL как единственный обязательный stateful store**, SQL-first migrations/queries через typed access layer (кандидат Kysely), транзакционный outbox, PostgreSQL-backed job worker; Redis и микросервисы не вводить заранее | Сильные DB-инварианты, повторяемость в SaaS и self-hosted, минимум компонентов; рабочую библиотеку jobs и версии закреплять после bootstrap | #10, #11, #19 / ADR-0002, ADR-0003 |
| **F0-P04** | **Минимальный kernel = lifecycle/module registry/contracts/context/capability plumbing**, без Booking, Tenant, Pricing, DB/ORM в самом kernel; Domain/Platform модули с contract imports | Изоляция без преждевременной hot-plugin runtime; разрешать shared DB transactions через узкий platform-порт, но не прямой cross-module SQL | #9 / ADR-0001 |
| **F0-P05** | **Booking consistency:** одна транзакционная команда, serializing lock на staff scope для create/reschedule/schedule conflicts, PostgreSQL `EXCLUDE USING gist` по tenant+staff+occupied range для Confirmed, idempotency + outbox в commit | DB защищает от double booking независимо от Telegram/web и гонок. Lock и exclusion — взаимодополняющие гипотезы, реальное SQL доказать integration/concurrency tests в F1 | #11 / ADR-0003 |
| **F0-P06** | **AuthZ:** deny-by-default, union только явно выданных allow-scopes роли в текущем tenant/location, затем hard restrictions resource ownership/tenant/entitlements; защищённые owner-права не делегируются обычным admin | Не допускать cross-location/tenant IDOR; permission matrix, guest-token и Telegram/phone linking проверить negative tests | #12 / ADR-0004 |
| **F0-P07** | **UX shell:** предварительная screen map и error states для web/Telegram/business; web и bot вызывают один Booking API; iframe на постороннем сайте — origin-validated postMessage, ограниченный контекст/permissions | Один продуктовый поток с разными оболочками, без копирования систем и без ложного optimistic success | #13 / ADR-0005 |
| **F0-P08** | **Trial/billing contract:** успешное создание Organization немедленно запускает 30 календарных дней; окончание считать в timezone Organization по тому же локальному времени +30 календарных дней, `endAt` exclusive; единый server-side entitlement | Предлагаемое точное временное правило. **Длительность/старт и paywall уже ACCEPTED**; timezone/DST и локальное время — PROPOSED до проверки кейсов и законодательства | #35, #39 / DEC-101–106 |
| **F0-P09** | **Мастер в paid tier:** считать по unique StaffProfile `active && published_for_booking && has_enabled_service` внутри Organization; отсутствие свободных слотов/отпуск при сохранённой публикации не обнуляет billable seat; `inactive/archived` исключать | Исключает двойной учёт multi-location и попытку обхода capacity через скрытие слотов. Предлагаемая конкретизация ACCEPTED «действующий и доступный для записи»; должна быть явно принята или изменена | #20, #35 / DEC-109–112 |
| **F0-P10** | **Commercial pilot:** персональный versioned оффер для салона **до регистрации**, бесплатный trial 30 дней, отдельный явный paid opt-in без автоплатежа; после отказа нет новых Booking, старые доступны для управления/экспорта; цены и правовые формы — research | Сохраняет все ACCEPTED DEC-099/101/103/105/107/109/111/113. Нельзя запускать реальные салоны без договора, обработки ПДн, оплаты и операционных гарантий | #14, #35, #37–39 |
| **F0-P11** | **Delivery:** сначала F1 internal web booking + calendar + tenant auth, затем пилотный F2 slice c menu-based Telegram, уведомлениями и минимальным onboarding; другие F2/F3 add-ons не блокируют первый пилот | Минимальная проверяемая бизнес-ценность при сохранении согласованных границ полного F2; нет AI в пилоте (ACCEPTED DEC-097) | #8, #15, #16–#30 |
| **F0-P12** | **F0 Gate:** владелец одним ревью принимает/исправляет пакет, ADR и риск-классификацию, после чего отдельная команда разрешает F1; не превращать каждую библиотеку в продуктовый вопрос | Устранить проблему бесконечного интервью, не снимать ответственность за P0 security/конкуренцию/деньги | #15 |

**Источники справки (проверены 2026-11-14, не являются performance benchmark):** [Node.js 26 LTS / календарь поддержки](https://nodejs.org/en/about/previous-releases), [SvelteKit adapters и static deployment](https://svelte.dev/docs/kit/adapters), [PostgreSQL exclusion constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [PostgreSQL range types](https://www.postgresql.org/docs/current/rangetypes.html). У Node 26 — LTS на дату документа; минорные версии/зависимости закреплять при F1 bootstrap, не в F0.

## Разделение решений по необходимости согласования

**Владелец ревьюит пакетом:** F0-P01..P12, scope/приоритеты, любые неожиданные компромиссы UX/коммерции, риски ПДн и момент старта F1.

**Самостоятельно в F1 в рамках утверждённого пакета решать:** организацию tsconfig/workspaces, схему миграционных файлов, idempotency key serialization, API DTO и enum-названия, component styling, provider retry backoff, выбор строго совместимой утилиты, внутреннюю структуру папок — с тестами и архитектурными ADR при изменениях.

**Нельзя «решить по умолчанию» без внешней проверки:** цену и состав персональных офферов, договор и платёжные реквизиты, российскую правовую модель ПДн, условия коммерческого hosting, consent на списание, уязвимости/security, возможность интеграций с закрытыми API, фактические лимиты нагрузки, успешность продаж.

## Границы пилотного MVP и F2 (не путать)

- **F1 internal (не продавать):** один Location в тестовой Organization (поле `locationId` сразу), каталог/сотрудники/графики, transactional Booking API, минимальный web UI + Business Calendar, tenant/auth/integration tests.
- **Первый пилотный срез:** F1 надёжно готов + публичный web booking + сценарный Telegram-бот без ИИ + автоматические подтверждения/напоминания (outbox + observability), салонный onboarding, trial/paywall/basic data export, минимальный security & operations gate.
- **Полный F2:** мультифилиальность и scoped roles, повторные клиенты, настраиваемое расписание, совместимые скидки/промокоды и price semantics, self-hosted, брендинг и договорённые дополнительные возможности. Не выдавать внутренний F1 или первый пилот за завершённый F2.
- **F3:** голос, MCP, склад/финансы и другие расширения после подтверждения спроса.

## Риски и какие доказательства обязаны появиться

1. **Корректность записи:** concurrency тест двух одновременных заявок в одну смену в разных каналах и филиалах, schedule edit vs booking, timezone/DST, idempotent retries, реальный PostgreSQL.
2. **Доступ:** матрица tenant/owner/admin/staff/client/guest; проверка multi-role, access to customer contacts/history/notes, revoke role, forged Telegram initData, guest token replay, bypass через bot/import/API.
3. **Пилотные деньги:** до регистрации каждого салона — собственный оффер и оценка ценности; после trial — отдельное согласие на оплату; считать **фактическую оплату**, а не регистрацию или согласие с тестом. Нет публичного прайса до данных.
4. **Операции:** юрисдикция/ПДн, коммерческий hosting РФ, backup/restore, ротация secrets, graceful cancellation/export, incident runbooks.
5. **Тариф:** capacity по уникальным действующим bookable StaffProfile, multi-location без двойного счёта, отсутствие booking quotas и автосписаний, отказ активации сверх tier с сохранением ранее Confirmed.

## Что показываем владельцу одним пакетом

**Порядок ревью (вместо интервью):**
1. [Этот лист рекомендуемых решений](f0-owner-review-package-20261114.md).
2. [Implementation blueprint / экраны / риски](../architecture/f0-implementation-blueprint.md).
3. [Traceability всех REQ](../delivery/requirements-traceability-f0.md).
4. [Пилотный commercial playbook](../product/pilot-commercial-playbook.md).
5. [Итог аудита и remaining blockers](../delivery/f0-consistency-audit-20261114.md).

**Не выполнять до явного приказа владельца:** merge PR #43, закрытие #15 как approved, смена статусов PROPOSED → ACCEPTED за владельца, создание production code, деплой, отправка данных/средств или рекламирование цены.

**Рекомендуемая формулировка итогового решения владельца, не действие агента:** «Пакет F0-P01..P12 одобряю, кроме следующих замечаний: …; согласен, что implementation details решаются инженерно, а безопасность/коммерческий пилот проходят отдельный gate».
