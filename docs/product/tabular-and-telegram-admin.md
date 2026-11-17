# Табличный обмен и Telegram-first управление салоном

**Продуктовое направление ACCEPTED (решение владельца 2026-11-17, DEC-116, REQ-068–072).** Конкретная реализация, форматы и operational gates ниже — PROPOSED до инженерного review. REQ-073 — PROPOSED, F3. Задачи: [#252](https://github.com/tim8es/cookie/issues/252), [#253](https://github.com/tim8es/cookie/issues/253), [#254](https://github.com/tim8es/cookie/issues/254).

## Цель и независимые маршруты
Салон сохраняет привычный табличный процесс: после аутентифицированной регистрации Organization и первоначальной безопасной привязки сотрудника может подготовить данные в Excel/другой таблице, загрузить их и получить рабочие справочники и опубликованное расписание после явного подтверждения. Затем может обновлять диапазоны (например, неделю/месяц), выгружать актуальные данные и результаты визитов, смотреть календарь, мастеров, услуги и записи через Telegram без посещения Business Workspace. Web остаётся полноценным альтернативным каналом; клиентский Telegram-бот остаётся полноценным. Не создаём отдельную базу таблиц или отдельный продукт.

## Матрица данных и порядок поставки
| Набор | Импорт v1 | Экспорт v1 | Особенности |
|---|---|---|---|
| Organization/Locations | настройки существующей Organization, филиалы в разрешённом scope | да | tenant выбирается сервером, не из файла; timezone IANA |
| Services | да | да | стабильный ключ, имя, длительность, цена; override только если доступен согласованный сервис |
| Staff, StaffLocationAssignments, StaffService | да | да | единый профиль с несколькими назначениями; создание и активация разделены |
| Schedule | да (смены, перерывы, исключения, диапазон дат) | да | интервал по локальному времени филиала, UTC и DST; явная публикация, проверка броней |
| Booking/Visit | нет в v1, позже при отдельной спецификации миграции | да, включая статус/дату/филиал/услугу/мастера и разрешённые финансовые поля | серверный статус и исторический price snapshot read-only при reimport |
| Customers/PII | не включать по умолчанию, отдельно reviewed schema | только при явном scope и legal gate | минимизация, редактирование/удаление по policy |
| Discounts, promotions, остальные поддержанные бизнес-настройки | последующие versioned schemas после готовности домена | в рамках прав/готовности | не импортировать secrets, Identity, роли, entitlement или произвольные DB поля |

Целевое требование — табличное управление поддерживаемыми операционными параметрами, не произвольный дамп БД. Полнота шаблона растёт с реализованным доменом; ограничения v1 не означают отказ от будущих параметров. В v1 допускается отдельный explicit publish после импорта либо подтверждение с выбором publish, но не скрытая активация. Пример структуры XLSX: Metadata (schemaVersion, exportRevision, period), Locations, Services, Staff, Assignments, StaffServices, Schedule, Bookings/Visits (read-only); CSV UTF-8 для отдельного набора с теми же logical columns. Точные заголовки/локализация, separator, лимиты, schema migrations и money units утверждаются контрактным review. Документ может быть сгенерирован на основе текущего tenant; текст/файл не источник полномочий.

## Импорт и повторное обновление
1. Получить актуальный шаблон/выгрузку в Web или Telegram. Заполнить локально.
2. Выбрать organization/location и период, загрузить файл. Сервер проверяет формат, размер, архив/формулы (не выполнять), версию, типы, ссылки, уникальность стабильных keys, даты и timezone. Отсутствующие обязательные поля — row errors, не тихие defaults.
3. Dry-run формирует ограниченный план create/update/no-op, конфликты и отчёт с листом/строкой/кодом. Никаких доменных записей на preview. Stable key не равен имени; tenant-scoped mapping внешних/внутренних ID и optimistic revisions. Изменившиеся данные после preview требуют нового плана.
4. Подтвердить допустимый план. По умолчанию атомарный apply ограниченного размера: ошибка/конфликт блокирует весь apply, пользователь исправляет файл; частичное применение только отдельным явным решением/контрактом. Никакого удаления по отсутствующей строке; явно scoped future replace/delete режим — отдельное review. Не переписывать прошлое и подтверждённые брони молча.
5. Revalidate текущие session/link/membership/permissions/location/entitlement, revisions, staff activation limits, scheduling/booking conflicts в согласованной транзакции. Идемпотентный ключ tenant+actor+import job; повтор после timeout возвращает прежний результат, изменённый payload не принимается под тем же ключом. Через публичные доменные transaction-scoped ports, canonical locks и audit/outbox; не bulk SQL bypass. Ограничить batch/lock duration и bounded error list. Job/event delivery идемпотентна.
6. Выгрузить результат (создано/обновлено/no-op/отклонено), audit actor/time/scope/hash/schema/version и корреляцию; не логировать raw payload/PII. Удаление временных файлов по утверждённой retention policy; rollback до commit, отмена после commit только через разрешённые компенсирующие действия.

## Экспорт
Выбор справочников/графика/визитов, периода и филиала; согласованный snapshot и разрешённые поля, timestamps с timezone и явный status. Экспорт writable данных пригоден для обратного импорта без дублей; рассчитанные/immutable поля отмечены read-only и игнорируются с явным предупреждением или отклоняются при изменении. Экспорт не изменяет данные и доступен после trial в рамках REQ-063. CSV/XLSX formula injection protection для пользовательских строк; безопасные имена, content-type и отсутствие secrets. В больших выгрузках — bounded jobs, pagination/streaming по контракту.

## Telegram admin
Один сценарный бот (#29), отдельные роли/claims и явное переключение клиент ↔ администратор; customer identity не выдаёт admin grant. Связанный Telegram identity → verified server session → active membership + role/location grant. При нескольких организациях — явный context selector на сервере; старые callback/сессии после revoke fail closed. Admin доступ в private chat, не в группе. Меню: расписание/календарь (день/неделя/месяц), записи и разрешённые действия (статусы посещений/перенос/отмена по текущему домену), список мастеров, услуги, скачать шаблон, загрузить/проверить/подтвердить файл, выгрузить. Полное редактирование всех web-настроек в чат не требуется: для массовых параметров есть файл. Клиентский путь остаётся отдельным и не получает бизнес-данные; пользователи без grant не видят admin меню, но безопасность всегда серверная.
Mini App использует shared presentational Svelte компоненты календаря, карточек, списков, фильтров, date selection и tokens с отдельными admin view models/permissions. Обычный bot требует отдельного представления кнопками/сообщениями, не может напрямую использовать DOM-компоненты. Не копировать бизнес-логику или server internals; оба используют те же API/capabilities. Никакой обязательной AI-зависимости.
Файлы из Telegram — untrusted data. Только приватный чат с актуальной authZ, preview/explicit confirm. Не отправлять raw customer PII вложением по умолчанию; чувствительные файлы только через защищённую короткоживущую ссылку с повторной авторизацией, no public reusable URLs; при невозможности законного провайдера — только защищённая web/Mini App загрузка. Объём Telegram/provider limits, consent, РФ hosting и retention — отдельная проверка до реального пилота.

## Архитектура
DataExchange — отдельная platform/application capability вне minimal kernel; parser/serializer и storage/job adapters не владеют доменными таблицами. Web и Telegram вызывают shared application service: template, planImport, confirmImport, getImportStatus, exportData (названия предложены, не wire API). Domain commands/queries под authoritative transaction and Policy, tenant context no user-supplied authority. Общие UI компоненты вне domain. SaaS и self-host используют одинаковые форматы и API; отсутствие Telegram adapter не ломает web import/export. Без прямой синхронизации Google Sheets в v1.

## Этапы и gates (предложенный порядок, не отменяет #203)
- F1: preserve existing stable IDs, revisions, scoped commands, dates/timezone, permissions и shared UI; не добавлять parser/Telegram admin как новый блокер текущего real-mode F1.
- Early F2, P0 #252: реальный Web import/export по доменам после #203 и зависимости. Первый вертикальный срез: справочники + график → видимы клиенту через API → визиты в выгрузке. При необходимости отдельно проверить малым gated staging pilot; не расширять текущий обязательный pilot scope DEC-095 без согласования.
- F2, P1 #253: после #252 и #29/#24, Telegram admin mode, повторное использование UI/API, доказанный путь без Business Web.
- F3, P2 #254 (PROPOSED): Sheets connector/scheduled обмен только по спросу, с conflict/source/revision contracts. Не обещать live sync, автоматические удаления и импорт всех исторических данных.
Работа с реальными ПДн, продуктивный Telegram, commercial rollout/payment по-прежнему требуют отдельного согласия и #37/#38; только synthetic fixtures на инженерном этапе.

## QA acceptance (не выполнено)
- Чистая Organization: template → valid workbook → preview → confirm → реальные PostgreSQL мастера/услуги/расписание, видимые публичному клиенту → бронь → посещение → выгрузка с реальным статусом.
- Web и Telegram round-trip, CSV/XLSX equivalence, понятные ошибки на broken refs/duplicate natural names/invalid time/DST/unknown schema/oversize/zip bombs; no spreadsheet formula execution, formula-safe export.
- Reimport no-op, concurrent different import, lost response/retry, stale preview, race с booking create, staff activation cap, permission/session/link revoke, cross-tenant and location IDOR, rollback on fault; без нарушения единой занятости мастера и price snapshot.
- Клиент без staff grant не получает данные/кнопки admin; admin может переключать tenant и не пересекает scope; Mini App component reuse, private bot file workflow, защищённые downloads и expired links.
- Post-trial existing visit management/export сохраняется, новые брони и сверхлимитная активация заблокированы во всех каналах; никаких автосписаний.
- Синтетический E2E и независимое QA/security review, provenance CI SHA. Pilot hypothesis: измерять time-to-first-published-schedule, долю успешных импортов без поддержки, долю админов, использующих Telegram без Web, support time; целевые числа установить на основании тестов.
