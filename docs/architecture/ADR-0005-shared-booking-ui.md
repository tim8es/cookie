# ADR-0005 — Общий Booking UI для сайта, виджета и Mini App

**Статус: PROPOSED** · Issue #13 · REQ-004,015.

## Цель
Одна бизнес-логика и система компонентов, три поверхности: публичная страница, iframe embed widget, Telegram Mini App. Никаких трёх независимых booking applications.

## Предложение
Framework-agnostic требование к общему Booking UI; предварительный основной кандидат Svelte 5 + Vite, React — сравнение. SvelteKit только если SSR/hybrid routes обоснованы; для Go backend статический frontend может устранить дополнительный server runtime. UI построен на shared components + route/state packages. Адаптер shell определяет auth/session (web vs Telegram), окружение, тему/контекст и интеграцию с платформой. Embed — iframe, загрузочный JS устанавливает безопасный iframe и postMessage с явной проверкой origin; не доверять parent window без валидации.

## Почему iframe
Изоляция CSS, CSP и сторонних сайтов, один релиз UI; цена — ограничения height/resize, cross-origin cookies и коммуникация с parent. Для авторизованного аккаунта в iframe возможно переключение top-level workflow, если third-party cookies недоступны.

## Альтернативы
Web component без iframe (стили/JS могут конфликтовать с сайтом); полное отдельное приложение для Mini App (дублирование UX); SvelteKit с SSR (требует отдельного анализа runtime/адаптера, может добавить сервис), React/Vite, web component без iframe и полностью отдельный Mini App. Vite — build tool, не альтернатива SSR сама по себе.

## Контракт
UI читает каталог/слоты из API, команды выполняет через Booking API. Telegram initData проверяет backend. Для guest доступа нет длинных токенов в URL. Настройки бренда задаются конфигурацией организации, не fork CSS.

## Референсы восприятия качества
Владелец выбрал **Telegram** и **Altare.gg** как примеры очень отзывчивого и приятного интерфейса. Используем их для UX benchmark по поведению: навигация, обратная связь, плавность прокрутки/календаря, обработка ожидающих операций, ясность состояний. **Не** копируем их визуальную айдентику или неподтверждённые технические решения.

Тест-план сравнения: выполнить одинаковые задачи (открытие записи, переход между датами, смена мастера, открытие детализации) в Cookie на бюджетном телефоне/Telegram WebView и субъективно сопоставить с референсами, дополнить объективными замерами при создании UI. Для бронирования success только после подтверждения транзакции backend; не имитировать успешную бронь оптимистичной анимацией.

## Производительность и размер
Мобильный календарь должен быть быстрым на бюджетных устройствах. Сравнение Svelte/React проводить на идентичном UX-сценарии с метриками LCP/INP/CLS, размером загруженного JS, интерактивностью календаря и доступностью; не считать победу фреймворка без измерений.

## Acceptance
Те же тестовые записи из всех поверхностей; mobile/desktop, iframe origin checks, корректные пустые состояния, е2е flow повторной записи и ссылок, отсутствие двойных бронирований.

## Рекомендуемая screen map для пакетного owner-review (PROPOSED F0-P02/P07, 2026-11-14)
- **Static Svelte 5 + Vite baseline** для общего public web/iframe/Telegram Mini App UI; SSR не внедрять до подтверждённой SEO ценности, React — fallback только при проверенной проблеме a11y/calendar ecosystem.
- Минимальные экраны: individual pilot offer до регистрации → регистрация и 30-day trial → wizard услуг/мастеров/графиков → business calendar / запись / перенос / отмена; public flow услуга → staff/location → slot → verified identity → quote → Confirmed; Telegram bot FAQ/menu/handoff; subscription status, voluntary upgrade, archive/export и сообщения о trial expiry.
- Критические ошибки: нет слотов, конкурентный 409, устаревший quote, отказ authZ/expired link, fail notification vs committed Booking, staff tier full, trial expired, embed cookie/origin mismatch и сетевой retry. Никакого optimistic success до DB commit.
- [Полная screen map](f0-implementation-blueprint.md#5-screen-map--готовый-документальный-набросок-не-дизайн-макеты); high-fidelity UI/benchmark на реальном телефоне — после разрешения F1. #13 ждёт owner review screen map.
