# ADR-0005 — Общий Booking UI для сайта, виджета и Mini App

**Статус: PROPOSED** · Issue #13 · REQ-004,015.

## Цель
Одна бизнес-логика и система компонентов, три поверхности: публичная страница, iframe embed widget, Telegram Mini App. Никаких трёх независимых booking applications.

## Предложение
React/Vite shared Booking UI + route/state packages. Адаптер shell определяет auth/session (web vs Telegram), окружение, тему/контекст и интеграцию с платформой. Embed — iframe, загрузочный JS устанавливает безопасный iframe и postMessage с явной проверкой origin; не доверять parent window без валидации.

## Почему iframe
Изоляция CSS, CSP и сторонних сайтов, один релиз UI; цена — ограничения height/resize, cross-origin cookies и коммуникация с parent. Для авторизованного аккаунта в iframe возможно переключение top-level workflow, если third-party cookies недоступны.

## Альтернативы
Web component без iframe (стили/JS могут конфликтовать с сайтом); полное отдельное приложение для Mini App (дублирование UX); SSR app вместо Vite (когда SEO/индексация стали доказанной необходимостью).

## Контракт
UI читает каталог/слоты из API, команды выполняет через Booking API. Telegram initData проверяет backend. Для guest доступа нет длинных токенов в URL. Настройки бренда задаются конфигурацией организации, не fork CSS.

## Acceptance
Те же тестовые записи из всех поверхностей; mobile/desktop, iframe origin checks, корректные пустые состояния, е2е flow повторной записи и ссылок, отсутствие двойных бронирований.
