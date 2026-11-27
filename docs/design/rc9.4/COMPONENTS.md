# RC9.4 — контракт компонентной системы для внедрения

32 позиции из каталога RC9.3/RC9.4. Ниже: назначение, предлагаемый интерфейс (не существующий Svelte API), ключевые состояния. Один компонент может композиционно включать другие. Переиспользовать уже существующие primitives; имена здесь логические. Не считать legacy-разметку, не имеющую контракта, автоматически мигрированной. При расхождении размеров использовать фактический визуальный эталон для соответствующего контекста, а не множить варианты.

| Контракт | Входы / варианты | Состояния и обязательства |
|---|---|---|
| Button | label, icon, variant=primary/secondary/ghost/destructive, size, type, disabled, pending, action | Один основной CTA, focus-visible, pending без двойной отправки; icon-only имеет имя. |
| TextField | label, id, value, type, placeholder, help, required, disabled, error | Связь label/input/error, controlled data, validation и сохранение значения. |
| SelectMenu | label, value, options(id,label,disabled), empty, onChange | Один стиль выбора; top layer/portal, выбор/keyboard/Escape/outside/scroll, восстановление фокуса. Не создавать отдельное меню филиалов. |
| CheckGroup | legend, values, options, onChange | Нативные checkbox, fieldset/legend, keyboard, disabled/invalid. |
| Segment | options, selected, onChange | Выбранное состояние, клавиатура, компактный вариант; вкладки и фильтры имеют соответствующую семантику. |
| SettingToggle | label, description, checked, disabled, reason, pending, onChange | Вся строка кликабельна, role=switch/aria-checked; права и tariff server-owned. |
| Avatar | name/initial, image, size | Fallback initials, optional alt; не дублирует действия аккаунта. |
| ChoiceRow | title, description, leading, trailing, selected, disabled, onSelect | Единый selection row: услуги, мастера, филиалы, radio choices. Selected не только цветом. |
| EntityRow | title, subtitle, metadata, leading, actions | Доступный row/action, не вкладывать button в button. |
| DirectoryRow | entity identity, title, metadata, selected, onOpen | Поиск/выбор записи справочника, ограничение доступа через модель. |
| EntityEditor | title, mode=create/edit, form schema, values, pending, errors, onSave/onCancel | Общая оболочка формы, данные/правила в feature, несохранённое/unknown result. |
| ImageAssetField | label, image, validation, pending, error, onUpload/onRemove | Пустой/preview/error, реальные upload/API ограничения, не data URL в постоянном storage. |
| VisitRow | visit id, time, service, staff, status, compact, onOpen | Один компактный/обычный вариант, статусы из server DTO, действия по capability. |
| MetricStrip | entries(label,value), loading, error, collapsed, onToggle | Без придуманных метрик, collapsed persistence как UI preference, no data vs zero. |
| ModuleSettings | modules(id,label,enabled,available,reason), onToggle | SettingToggle, единственный источник доступности; без UI-only authorization. |
| PageHeader | title, organization, global controls, secondaryActions, primaryAction | Одно имя раздела, 44px контролы, CTA справа, mobile wrap, отсутствующий action не подменять. |
| QuickAction | label, icon, capability, action, pending | Button primary; контекстное действие экрана, не фиктивный переход. |
| WorkspaceAccount | org, actor, role, memberships, onOpen | Одна карточка в sidebar; на mobile в «Ещё», без отдельного аватара шапки. |
| ScrollArea | axis=x/y, maxSize, label, children | Нативная прокрутка, keyboard/touch/wheel, scroll only if overflow; общий scrollbar tokens. |
| PublicHeader | organization, logo, contextual action, surface | Общий header, адаптер контекста вместо fork, длинные имена. |
| SalonHero | branding, title, intro, image, cta | Опубликованная тема, responsive, доступный контраст, fallback assets. |
| SalonCatalog | services, people, displayOrder, showStaff | Тема, empty/loading/error, валидные published records. |
| PublicCatalog | entries, search, filter, onSelect | Общий публичный справочник; данные сервера, пусто/нет совпадений различать. |
| PublicServiceRow | service id/name/price/duration/description, selected | Композиция ChoiceRow/EntityRow; реальная доступность и цена. |
| PublicStaffRow | staff id/name/specialty/photo, selected, disabled | Композиция ChoiceRow/Avatar; доступные мастера из API. |
| SalonPage | published configuration, catalogue, shell, actions | PublicHeader + SalonHero + SalonCatalog; unavailable/unpublished честно. |
| SurfacePreview | surface=web/embed/mini, draft, published, onChange | Реальный общий layout в preview; не считать симуляцию проверкой Telegram/iframe. |
| BookingLayout | context, step, draft selections, view-state, shell, events | Один layout на всех каналах, API отдельно; адаптер контекста, адаптивная колонка итогов. |
| BookingProgress | steps, current, completed, canGoBack, onNavigate | 4 визуальных этапа; aria-current=step, future disabled, безопасный возврат. |
| ServicePicker | services, query, selected, onSelect, state | Search + ChoiceRow; server loading, error, empty/no match; доступные услуги. |
| BookingTicket | selection, quote, availability, state, onContinue | Summary, фактическая цена/длительность, pending/error/price-change; нельзя показывать успех до commit. |
| DemoToolbar | review state, fixtures, test action | **Только изолированный QA/catalog. Не переносить в продуктовые routes.** |

## Важные элементы, не считать закрытыми только из-за реестра 32

В production должны быть проверены существующие `Card`, `Badge`, `Dialog`, `Label`, `Separator`, календарь/slot picker, toast/notice, empty/error/loading и command search. Это реальные примитивы/паттерны, часть которых представлена в RC9.4 как композиция, но не все являются отдельными data-component ID. При миграции зарегистрировать их отдельными stories в той же библиотеке, если они имеют независимый контракт; не создавать новую копию для каждого экрана. Подтверждение и управление визитом используют общие Button, dialog, Ticket и state components. Проверять каталог по экспорту Svelte-компонентов и реальным импортам, а не только по строковому поиску data-component.

## Токены и изменения

`token-reference.json` — фактический snapshot вычисленных CSS variables и геометрии на ширине 1366px в прототипе, не production stylesheet. Нужна миграция значений в существующий `apps/web/src/styles/tokens.css` и один семантический слой. Геометрия: 44px рабочая шапка; booking search 48px, шаги минимум 54px, карточки услуг минимум 76px; внутренние варианты только там, где меняется семантика/плотность. Публичная тема ограничена shell. Вся продуктовая стилизация через токены/variants, а не глобальные `!important` цепочки из RC. При изменении цвета/радиуса/типографики переснять каталог и рабочие сценарии, проверить контраст/фокус и mobile.
