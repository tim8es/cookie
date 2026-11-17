# Cookie: ручное тестирование настоящего API (локально и Altare)

**Только F1 engineering / synthetic staging.** Не используйте настоящие данные клиентов, production DB, настоящий bot token или коммерческие платежи в локальном сценарии.

## 1. Локально (Windows / macOS / Linux)

### Полноценное локальное демо (Issue #311)

`pnpm demo:local` собирает **тот же** runtime и открывает настоящий owner workspace на loopback. Команда использует тот же launcher, сервер, Svelte bundle, PostgreSQL migrations, domain seed, signed synthetic owner/client login и staging API. Никакого второго frontend, mock backend или новых HTTP auth bypass.

Каждый запуск создаёт свежий случайный Compose project `cookie-demo-*`, отдельный порт, БД/volume, ключи, синтетический салон и отдельный браузерный профиль. `owner` / `client` меняют роль; Enter обновляет сессию. При штатном закрытии приложения или Ctrl+C удаляется только собственный disposable project/volume; следующий запуск начинается с чистого салона. В случае ошибки удаления сохраняется приватное состояние для ручного восстановления; при аварийном SIGKILL автоматическая очистка не гарантируется. Никогда не удаляйте persistent `cookie-manual-*` или чужие volumes. Не публикуйте local state или credentials.

Демо при старте создаёт через штатные авторизованные HTTP-команды одну синтетическую услугу «Демо-стрижка», мастера, публикует их и смену на дату через три дня. Дата выводится в терминал; можно сразу переключиться на клиента командой `client` и записаться. Используются существующие TypeScript API clients (tsx уже входит в devDependencies), никаких отдельных правил записи. Служебная сессия отзывается после seed. При неподтверждённом seed запуск завершается, отдельная БД удаляется по обычному lifecycle. QA start по-прежнему не заполняет каталог.

Демо воспроизводит реально подключённые функции текущего staging build; отсутствующие рабочие сценарии не эмулируются. Скомпилированный API возвращает 404 на старом `/demo` и его подмаршрутах. Browser-local fixture сохраняется только для отдельной сборки `pnpm --filter @cookie/web build:fixture` / `dev:fixture`. Сборка runtime проверяет отсутствие mock controller/adapter по графу модулей. Fixture build сохраняется в `.tmp/ui-fixture-dist`, отдельно от `dist`; это не продуктовый деморежим и не доказательство паритета. Публичное демо, автоматизированное сравнение всех экранов и полное удаление legacy fixture остаются в #311. Это локальный synthetic launcher, не разрешение на публикацию synthetic login или коммерческий пилот.

### Private headless demo worker — только инженерная проверка

Внутренний `serve-demo` получает управляющий IPC-канал от доверенного родительского процесса и обязательный `COOKIE_DEMO_WORKER_TTL_SECONDS` (1–900); прямой запуск без IPC запрещён. Это тот же compiled runtime, bootstrap и seed, но без Chromium. Сервер привязан только к 127.0.0.1, у каждой сессии собственные Compose project, database/volume, tenant, keys и port. Одноразовый signed proof выдаётся только по IPC для заранее созданных synthetic owner/client; в HTTP, URL, stdout и пользовательские настройки он не попадает. Stop, завершение TTL или потеря IPC запускают штатную очистку только своего disposable проекта; SIGKILL и остановка Docker требуют ручного восстановления по state. Не публиковать этот IPC за HTTP proxy.

`pnpm demo:verify-isolation` (CI=true, Docker и готовый runtime) создаёт две одновременно живущие сессии, проверяет отсутствие доступа с чужим proof и bearer, сохранение собственного изменения и отсутствие его в соседней БД, остановку/удаление только своего проекта, чистый третий запуск и expiry. PrivateDemoManager резервирует лимит слотов до начала запуска, считает starting/ready/stopping/quarantined, маршрутизирует одно IPC-запрашиваемое подтверждение роли на сессию и освобождает слот только после завершения процесса и проверки отсутствия Compose containers/volumes/networks по точному project label. Ошибка или неизвестный результат очистки сохраняет слот до ручного восстановления; лимит и TTL явно задаёт оператор, не продуктовый клиент. Внутренний `manager.route(sessionId)` создаёт fetch-совместимый транспорт, привязанный к конкретной активной сессии: upstream только из проверенной записи manager, canonical `/v1/` paths, ограниченный набор HTTP methods/headers, до 256 KiB JSON body и timeout 15 s, без Cookie/forwarded headers, внешних redirect или клиентского выбора upstream. Старая route-ссылка не переживает stop/IPC disconnect/expiry даже при повторном использовании порта. Реальные AuthN/AuthZ проверки API сохраняются; sessionId сам по себе не является публичным credential. Это внутренний доверенный supervisor, не публичный login flow; публичная выдача сессий, квоты, rate limits, abuse protection, маршрутизация, удалённый доступ и recovery after host crash требуют reviewed архитектуры и отдельного разрешения. Никакого deployment в рамках данного среза.

### Постоянный локальный QA-контур

Требуются Git, Node.js 26, Docker Desktop/Engine + Compose v2, Chrome/Chromium или Edge. Запускайте из корня checkout.

```sh
npm install --global corepack@0.36.0
corepack enable
pnpm install --frozen-lockfile
pnpm staging:local
```

Скрипт автоматически:
- запускает отдельный PostgreSQL 16 в Docker с loopback-портом и persistent volume;
- применяет миграции и создаёт синтетический салон с одним филиалом через операторский domain API;
- генерирует уникальные локальные ключи, привязывает тестового владельца и отдельного клиента к подписанным synthetic Telegram proofs;
- запускает существующий compiled Fastify и API-mode Svelte bundle на 127.0.0.1;
- открывает отдельное окно Chrome/Edge и проходит обычный серверный HMAC exchange + проверку tenant/permissions. Не изменяет серверный AuthN, не добавляет маршрут тестового входа и не использует mock API.

Открытое окно — рабочий кабинет. В обычной вкладке без signed proof вход намеренно не работает. Для повторного входа после истечения 15 минут, logout или F5 нажмите Enter в терминале; это создаёт новый proof. Команды `owner` и `client` переключают разные тестовые Identity в одном tenant. Для отдельного демо используйте `pnpm demo:local`. Для явного отзыва старого bearer нажмите «Выйти» перед сменой роли; иначе он может действовать до expiry. Ctrl+C завершает API и тестовый браузер. Данные PostgreSQL сохраняются. Повторный запуск возвращает тот же тестовый tenant; ключи и настройки хранятся в игнорируемой `.tmp/manual-staging/state.json`. Не публикуйте этот файл, не переносите на Altare. Не удаляйте state при сохранении DB.

Если браузер не найден, в PowerShell:
```powershell
$env:COOKIE_BROWSER_BINARY = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node scripts/local-staging.mjs
```

После завершения тестов остановите только выделенный контейнер (без удаления volume):
```sh
pnpm staging:local:stop
```

При аварийном завершении убедитесь, что процессы API/изолированного браузера действительно закрыты, затем удалите только `.tmp/manual-staging/run.lock` и запустите повторно. Для полного сброса используйте отдельный checkout или вручную удалите только соответствующий Docker Compose project/volume **после** сохранения нужных тестовых данных (имя project записано в local state). Не удаляйте чужие volumes.

### Что проверять

1. Обзор → филиал → услуги → мастер → расписание. Создайте уникальные тестовые названия.
2. Завершите процесс, перезапустите, проверьте сохранённые записи.
3. На вкладке мастеров доступна активация в controlled staging, когда эта функция присутствует в checkout. Локальный скрипт создаёт исключительно синтетический, невозобновляемый grant на 5 мастеров на 30 дней; не моделирует коммерческий тариф.
4. В интеграционной ветке опубликуйте смену, введите `client` в терминале, выберите филиал, услугу, мастера и слот, подтвердите запись; проверьте «Мои записи», затем `owner` → календарь. В локальном runtime доступна и реальная отмена своей записи: в «Мои записи» нажмите «Отменить запись», подтвердите действие и проверьте статус в календаре владельца. Без явного входного параметра отмена отключена. Для временного локального QA задайте `COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES` в терминале перед запуском (пример PowerShell: `$env:COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES = "90"`; допустимое целое 0–525600), и выберите запись с интервалом до начала больше указанного. Для отключения: `Remove-Item Env:COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES`. Это только process-local staging конфигурация, не утверждённое значение и не полноценные настройки салона; [#285](https://github.com/tim8es/cookie/issues/285) требует tenant-scoped настройки владельца. Перенос, public Booking и worker/provider acceptance остаются отдельными gates.

В скомпилированном runtime `/` всегда использует API; legacy `/demo` возвращает 404. Для ручной проверки реального backend используйте только команды выше. Не переносите тестовые ключи или данные из локального UI на реальный сайт.

## 2. Altare App Hosting (private synthetic staging)

App Hosting поддерживает Node.js 26, команды install/build/start, HTTPS и provisioned PostgreSQL 17. Документация: https://docs.altare.gg/apps и https://docs.altare.gg/databases/postgres. Используйте App Hosting, не Sandbox. Сначала убедитесь в exact-head CI на PostgreSQL 17, наличии backup/restore evidence и возможности ограничить доступ к staging. Не включайте public Booking и PII.

| Поле | Значение |
|---|---|
| Source | tim8es/cookie, принятый проверенный commit через выделенную staging branch |
| Root | репозиторий целиком |
| Runtime | Node.js 26 |
| Install | `npm install --global corepack@0.36.0 && corepack enable && pnpm install --frozen-lockfile` |
| Build | `pnpm build:runtime` |
| Start | `pnpm start:api` |
| Health | `/health/ready` |
| Env | `HOST=0.0.0.0`, `COOKIE_WEB_DIST=apps/web/dist`, `DATABASE_URL` |

Платформа предоставляет `PORT`; не фиксируйте его вручную. БД должна быть **отдельной**, синтетической. Примените `pnpm db:migrate` из проверенного checkout однократно в доверенном operator/command environment с той же DATABASE_URL до допуска трафика; проверьте миграции. Для managed Postgres подтвердите CA/TLS connection string; не отключайте проверку сертификата. Не помещайте пароль в Git или build log. Не запускайте миграции при каждом рестарте.

Далее используйте реальные server-only Telegram settings и проверенную owner-link процедуру из [telegram-owner-auth-staging.md](telegram-owner-auth-staging.md). В том числе `COOKIE_TELEGRAM_AUTH_MODE=enabled`, `COOKIE_PUBLIC_ORIGIN` (точный HTTPS origin), индивидуальный bot token и независимый HMAC secret, предоставленные только доверенным оператором. **Локальные synthetic credentials и CDP launcher запрещены на Altare.** Привязка владельца требует проверенного initData и явного согласия; прямой URL не даёт доступ. Если approval на фактический Telegram provider ещё не получен, не включайте этот режим. Без неё можно проверить только startup/health и закрытый AuthN gate.

Для управляемой публикации в private staging дополнительно нужен проверенный operator-issued grant и `COOKIE_STAGING_PUBLICATION_MODE=enabled` (см. [staging publication capacity](../delivery/staging-publication-capacity-20261117.md)); не включайте без принятого security review. Customer write flag, cancellation cutoff и public API в этом Altare runbook намеренно не активированы.

После deploy проверьте HTTPS, `/health/ready`, вход/отказ доступа, реальные SQL записи, restart/persistence, логи без secrets, restore на отдельной тестовой DB. Не утверждайте, что deployment проверен, без URL/commit/observed results. Отключите автоматический rollout произвольных feature branches; отдельная staging branch обновляется только после проверки.

## Границы этого изменения

Это интеграционный launcher и runbook, не production readiness. Оформление и создание записи владельцем не подключены. Не добавляется HTTP bypass, не выдаются токены с клиента, не трогаются booking/identity contracts, не включаются provider notifications. CI дополнительно запускает `node scripts/local-staging.mjs verify` (без cutoff) и `node --import tsx scripts/local-staging.mjs verify-demo` (с явным тестовым cutoff 90) в разных disposable Docker-проектах. Оба режима проходят один сценарий реального каталога: проверка начального состояния (пусто в QA, одна опубликованная услуга в demo), форма на 1280/375/320 px, создание услуги, проверка строки и receipt в БД, переключение клиента и владельца, отказ без signed proof, чтение сохранённой услуги после нового входа. Demo дополнительно проходит полный доступный жизненный цикл брони: клиент создаёт запись на реальную опубликованную смену, выходит из сессии, владелец видит подтверждённую бронь в календаре (день/неделя, 320/375/1280), клиент повторно входит и отменяет запись, владелец видит `CancelledByClient`; проверяются тот же ID и цена в PostgreSQL, серверные logout и отсутствие browser storage после подтверждённых операций. Cutoff 90 — явный synthetic CI input, не продуктовый default. Перенос и создание записи владельцем не имитируются. Оба runtime проверяют 404 для legacy `/demo`; существующие UI fixtures по-прежнему проверяются отдельным браузерным smoke. Это одна функциональная проверка паритета, не полное сравнение всех экранов. Это проверка самого launcher на Linux, не Windows GUI или Altare. Independent review + настоящий локальный Windows/Docker/browser run + remote staging verification обязательны; #203 остаётся открытым.
