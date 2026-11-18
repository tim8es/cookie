# Самостоятельный вход: приватный staging

Эта конфигурация предназначена для отдельного private App Hosting приложения с синтетическими аккаунтами. Она включает самостоятельный вход и регистрацию без предварительной ручной привязки клиентов. Она не открывает production, публичный пилот, реальные клиентские данные или платежи.

## Altare App Hosting

Выберите Node.js 26, проверенную staging-ветку и те же команды сборки и запуска из [manual-real-staging.md](manual-real-staging.md). В настройках приложения храните значения как environment variables / secrets. Не добавляйте их в GitHub, `.env` коммиты, скриншоты или логи.

Базовые переменные приложения:

| Variable | Purpose |
|---|---|
| `COOKIE_PUBLIC_ORIGIN` | Точный HTTPS origin Altare приложения без пути, например `https://<app>.go.altare.global` |
| `COOKIE_TELEGRAM_USER_HMAC_SECRET` | Независимый стабильный секрет в формате 64 hex символов |
| `COOKIE_TELEGRAM_SELF_REGISTRATION_MODE` | `enabled` включает регистрацию через Mini App |
| `COOKIE_EMAIL_AUTH_MODE` | `enabled` включает email/password API |
| `COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET` | Независимый 32-byte hex секрет для email fingerprint |
| `COOKIE_AUTH_MAIL_ADMISSION_SECRET` | Независимый 32-byte hex ключ для rate-limit fingerprint |
| `COOKIE_AUTH_MAIL_ENCRYPTION_KEY` | Независимый 32-byte hex ключ шифрования очереди писем |
| `COOKIE_STAGING_PUBLICATION_MODE` | `enabled` только для частного staging с отдельным operator-issued grant |

`COOKIE_TELEGRAM_SELF_REGISTRATION_MODE` и `COOKIE_EMAIL_AUTH_MODE` выключены, если переменные отсутствуют. Для web-входа через Telegram дополнительно задайте:

| Variable | Purpose |
|---|---|
| `COOKIE_TELEGRAM_OIDC_MODE` | `enabled` включает web OIDC |
| `COOKIE_TELEGRAM_OIDC_CLIENT_ID` | Client ID из BotFather Login Widget |
| `COOKIE_TELEGRAM_OIDC_CLIENT_SECRET` | Client Secret из BotFather Login Widget |
| `COOKIE_TELEGRAM_OIDC_REDIRECT_URI` | Точный callback `https://<app-domain>/auth/telegram/callback` |
| `COOKIE_TELEGRAM_OIDC_COOKIE_KEY` | Отдельный случайный 32-byte hex ключ для state cookie |

Для Mini App также задайте `COOKIE_TELEGRAM_BOT_TOKEN` как секрет. В BotFather зарегистрируйте домен приложения и точный OIDC callback в Allowed URLs. OIDC client credentials отличаются от bot token. Не отправляйте эти значения в чат; создайте и вставьте их непосредственно в Altare secrets.

Для генерации каждого hex-ключа локально используйте `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Для каждого назначения сгенерируйте отдельное значение; не заменяйте HMAC секрет email ключом или ключом cookie.

## Доставка email

На собственном сервере по умолчанию используется абсолютный путь в `COOKIE_AUTH_MAIL_SENDMAIL_PATH` к доверенному sendmail-compatible MTA. Для Altare API задайте:

| Variable | Value |
|---|---|
| `COOKIE_AUTH_MAIL_TRANSPORT` | `altare-api` |
| `COOKIE_AUTH_MAIL_FROM` | Адрес на подтверждённом домене отправки Altare |
| `ALTARE_EMAIL_TOKEN` | Секрет токена, созданного через Altare Email → API and SMTP → Connect to app |

Altare Email API принимает письма только с подтверждённых доменов и требует Altare Plus или Business. На Always Free этот адаптер вернёт ошибку тарифа, письмо не отправится, и пользователь не сможет закончить email-регистрацию. На бесплатной среде нужен другой настроенный mail provider или sendmail-compatible MTA; email-регистрация не считается проверенной до получения письма в тестовый почтовый ящик.

Очередь сообщает, что письмо принято почтовым API, а не гарантирует появление во входящих. Проверяйте статус отправки в Altare Email Activity. Используйте только почтовый ящик, который контролирует тестировщик, не email реального клиента.

## Потоки тестирования

1. `GET /v1/auth/methods` должен показывать только настроенные способы. Основной `/` в API mode открывает самостоятельный вход; `/?surface=demo` остаётся изолированным mock.
2. Через Telegram Mini App или web OIDC зарегистрируйте синтетический тестовый аккаунт. Email-поток: запросите письмо, откройте `/register#token=…`, задайте пароль длиной не менее 15 символов и войдите.
3. Выберите «Я представляю бизнес» и создайте Organization с первой Location. Настройки сохраняются в PostgreSQL; bearer хранится только в памяти вкладки.
4. Привяжите второй способ входа в разделе «Привязанные методы». Email linking требует подтверждения ссылки и пароля; Telegram linking требует новой OIDC/Mini App проверки. Затем выйдите и войдите каждым привязанным способом.
5. Клиентский сценарий доступен только при `COOKIE_STAGING_PUBLICATION_MODE=enabled` и настроенном Identity provider. В кабинете появится ссылка на клиентскую test page для этой организации. Клиент явно подтверждает создание своей роли; сервер проверяет активное тестовое разрешение. Не вводите пользовательский tenant/identity ID как основание доступа.
6. Password recovery доступен по ссылке из письма `/recover#token=…`; одноразовые доказательства истекают и не передаются в query string.

Публикация и создание тестовых записей остаются отдельными server-side staging gates. Не включайте `COOKIE_STAGING_CUSTOMER_BOOKING_MODE` без проверки exact-head CI, PostgreSQL integration и соответствующих security gates. Обычная успешная регистрация не является доказательством готовности #203.

## Чек перед Altare deploy

- Сначала exact-head CI должен пройти миграции и integration tests на PostgreSQL 16 и 17.
- В Altare должен быть отдельный staging DB; примените миграции однократно из проверенного operator environment до включения трафика.
- Сверьте Altare deployment branch/commit и задайте health check `/health/ready`.
- Подтвердите домен и Allowed URLs в BotFather; установите OIDC и mail secrets через настройки Altare.
- Проверьте регистрацию, вход обоими методами, linking, logout, expiry и recovery на синтетическом аккаунте. Не включайте real customer PII, production, public pilot или payments.
