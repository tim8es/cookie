# RC9.4 — проверка и согласование с текущим Svelte UI Kit

Статус: визуальный кандидат для внедрения. Не Design Freeze, не runtime acceptance. Refs #338, #382, #428. Этот документ уточняет архивный HANDOFF.md без изменения его исторического содержимого.

## Проверенные материалы

- Открывать локально [index.html](index.html), например `python -m http.server 8000` из этой папки. HTML не является production entrypoint. GitHub отображает исходник, а не запускает приложение.
- [Регрессионный отчёт](rc94-regression.json): 195/195; 12 проверок × 3 роли × 4 ширины, 3 проверки workspace, 12 проверок × 4 ширины каталога. Тесты покрывают выбор услуги и переход к филиалу/мастеру, базовую геометрию, каталог, ScrollArea. Число явно размеченных компонентных имён в отчёте — **29**, строк контракта — **32**; название отдельного теста «27 source components covered» историческое, не критерий полной миграции.
- [Product/review report](product-view-results.json): 32/32, по 8 проверок на 375/1366 px для каждого из двух режимов.
- [Copy audit](copy-audit.json): точечные замены служебных надписей, не исчерпывающий аудит всей продуктовой копии.
- 2026-11-27 оба исходных Python/Playwright теста из полного архива повторно выполнены в Chromium на копии неизменённых HTML: 195/195 и 32/32 PASS. Используется set_content; реальные URL-переходы и реальный API/DB этим не подтверждены.
- Исходные отчёты сохранены без изменения (Git blob SHA соответственно `60d49d69d45680c745f1e0b657e249090caed575`, `be054104a5af39e8df01876a3dda34cb42431a26`, `291445ef3df84afef3f9db18fedc3aa20cbf0ad1`).

Полный исходный архив `kuki-rc9.4-design-handoff.zip` (SHA-256 `3bc5c443a376f40ec15613158c685384efe28a47d2d7e516639c5d1e1fd334b7`) сохранён в библиотеке /Kuki/. Он дополнительно содержит скриншоты, `build_rc94.py`, `test_regression.py`, `test_product_view.py` и `base-rc9.3/`, на которые ссылается исторический HANDOFF.md. Архив/бинарные снимки и исходные Python scripts не включены в этот PR. Для локального повторения исходных тестов на архиве: распаковать, установить Python Playwright и Chromium (скрипты ожидают /usr/bin/chromium), выполнить `python test_product_view.py` и `python test_regression.py` в папке пакета. Для внедрения архив не требуется: HTML, токены, контракты, карта экранов и acceptance в GitHub.

## Согласование D6 с уже начатой реализацией

Проверен [PR #382](https://github.com/tim8es/cookie/pull/382), head `f9ba9e1019753594c166495c6a425f2d530c976e`: `apps/web/RHYTHM_UI_KIT.md`, `apps/web/src/lib/components/rhythm/index.ts`, `contracts.ts`. В экспортном API 28 компонентов, не десять из первоначального описания PR. Это исходная проверка, не результат сборки, визуальной или серверной приёмки. Не создавать вторую библиотеку и не начинать независимую реализацию этих компонентов. При интеграции сверить актуальный head и изменения активных агентов.

| RC9.4 | Существующий кандидат #382 / действие |
|---|---|
| Button / QuickAction | ActionButton + существующий shadcn Button; capability и смысл CTA остаются у вызывающего экрана |
| TextField, CheckGroup, Segment, Avatar, ChoiceRow | Одноимённые компоненты; ChoiceList для наборов строк |
| SelectMenu | PopoverMenu; проверить формы, disabled, top-layer/portal, позиционирование, клавиатуру |
| SettingToggle, ModuleSettings | ModuleSettings; выделить общую строку switch при повторном использовании, не создавать параллельный toggle |
| EntityRow / DirectoryRow | RecordRow; внутренний RowContent не экспортировать как публичный дубль |
| EntityEditor, ImageAssetField, VisitRow | Одноимённые; ResourceDay/ScheduleRow используют общие строки |
| MetricStrip | Одноимённый; проверить loading, empty/error, scoped collapse, отсутствие вымышленных значений |
| PageHeader | В публичном API Rhythm отдельного PageHeader нет; согласовать общий компонент с существующими Topbar и shell |
| WorkspaceAccount | AccountMenu, Navigation, Avatar; карточка организации как единственный desktop entry, mobile через «Ещё» |
| ScrollArea | Отдельного публичного ScrollArea нет; общий native overflow/scrollbar tokens, проверить DateStrip/SlotGrid и все потребители |
| PublicHeader / SalonPage | Одноимённые; SalonHero, SalonCatalog, PublicCatalog и public rows — композиции существующих RecordRow/ChoiceRow/Avatar, не независимые темы |
| SurfacePreview | ThemeScope + изолированное preview существующего layout; реальные published values из API |
| BookingLayout / BookingProgress | BookingLayout; проверить семантику шагов, не дублировать workflow |
| ServicePicker | ChoiceList + TextField/Input + EmptyState, при необходимости обёртка, не новый выбор услуги |
| BookingTicket | Одноимённый display-only компонент; цена/доступность/commit из сервера |
| DemoToolbar | Только тестовая оболочка; не импортировать в product |

Дополнительно переиспользовать Modal/Notice/EmptyState, DateStrip/SlotGrid, текущие UI-примитивы; проверять публичные экспорты и stories. Список 32 в COMPONENTS.md — логический каталог, не требование создать 32 новых файлов. D6: сначала diff RC9.4 к существующим компонентам, расширить и проверить их контракт, затем мигрировать реальные экраны. Кандидат #382 не считается автоматически принятым и не блокирует независимые F1-задачи.

## Незакрытые гейты

- Визуальная приёмка настоящего Svelte runtime, состояние public booking #222, реальные auth/tenant/API и DB-проверки, device/Safari/Telegram/iframe; ручное сопоставление всех экранов и ролей, доступность и отсутствие legacy-двойников.
- Для каждого PR фиксировать screen ID, reference, актуальный head SHA, снимки actual/reference, проверки и отклонения. Не менять ACCEPTED REQ/DEC/ADR. Никаких новых разрешений F2, production, реальных ПДн или платежей.
