# Cookie: ручное тестирование настоящего API (локально и Altare)

**Только F1 engineering / synthetic staging.** Не используйте настоящие данные клиентов, production DB, настоящий bot token или коммерческие платежи в локальном сценарии.

## 1. Локально (Windows / macOS / Linux)

### Одноразовое локальное демо для разработки (Issue #311)

По уточнению владельца это временный внутренний инструмент, чтобы открыть актуальный интерфейс и проверить действия. Не продуктовая демоверсия для покупателей. Не добавлять серверный менеджер, gateway, публичный вход, TTL, автоматическое crash recovery или инфраструктуру для параллельных пользовательских сессий.

`pnpm demo:local` собирает **тот же** runtime и открывает настоящий owner workspace на loopback. Команда использует тот же launcher, сервер, Svelte bundle, PostgreSQL migrations, domain seed, signed synthetic owner/client login и staging API. Никакого второго frontend, mock backend или новых HTTP auth bypass.

Каждый запуск создаёт свежий случайный Compose project `cookie-demo-*`, отдельный порт, БД/volume, ключи, синтетический салон и отдельный браузерный профиль. `owner` / `client` меняют роль; Enter обновляет сессию. При штатном закрытии приложения или Ctrl+C удаляется только собственный disposable project/volume; следующий запуск начинается с чистого салона. В случае ошибки удаления сохраняется приватное состояние для ручного восстановления; при аварийном SIGKILL автоматическая очистка не гарантируется. Никогда не удаляйте persistent `cookie-manual-*` или чужие volumes. Не публикуйте local state или credentials.

Демо при старте создаёт через штатные авторизованные HTTP-команды одну синтетическую услугу «Демо-стрижка», мастера, публикует их и смену на дату через три дня. Дата выводится в терминал; можно сразу переключиться на клиента командой `client` и записаться. Используются существующие TypeScript API clients (tsx уже входит в devDependencies), никаких отдельных правил записи. Служебная сессия отзывается после seed. При неподтверждённом seed запуск завершается, отдельная БД удаляется по обычному lifecycle. QA start по-прежнему не заполняет каталог.

Демо воспроизводит реально подключённые функции текущего staging build; отсутствующие рабочие сценарии не эмулируются. Скомпилированный API возвращает 404 на старом `/demo` и его подмаршрутах. Browser-local fixture сохраняется только для отдельной сборки `pnpm --filter @cookie/web build:fixture` / `dev:fixture`. Сборка runtime проверяет отсутствие mock controller/adapter по графу модулей. Fixture build сохраняется в `.tmp/ui-fixture-dist`, отдельно от `dist`; это не продуктовый деморежим и не доказательство паритета. Публичное демо и отдельная инфраструктура исключены из #311. Legacy fixture оставлен только для текущих регрессионных проверок; не развивать его как второй UI. Это локальный synthetic launcher, не разрешение на публикацию synthetic login или коммерческий пилот.

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
4. Опубликуйте смену, введите `client` в терминале, выберите филиал, услугу, мастера и слот, подтвердите запись; проверьте «Мои записи», затем `owner` → календарь. Включённые операции отмены и переноса доступны в соответствующем кабинете. Перенос меняет только время, не услугу, мастера, филиал или исходную стоимость. Выбирайте свободное время из списка сервера; результат подтверждает сервер. Перед сменой роли выйдите из текущего кабинета.

### Явные настройки локального QA для операций с записью

И `pnpm staging:local`, и `pnpm demo:local` принимают четыре независимых process-local параметра. Без параметра соответствующая операция отключена; значение `0` допустимо и не означает отсутствие настройки.

| Переменная | Операция |
|---|---|
| `COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES` | Отмена клиентом |
| `COOKIE_MANUAL_RESCHEDULE_CUTOFF_MINUTES` | Перенос клиентом |
| `COOKIE_MANUAL_OWNER_CANCEL_CUTOFF_MINUTES` | Отмена владельцем |
| `COOKIE_MANUAL_OWNER_RESCHEDULE_CUTOFF_MINUTES` | Перенос владельцем |

Допустимые целые значения: 0–525600 минут. Срок проверяет сервер; до начала записи должно оставаться больше указанного числа минут. Для проверки всех операций можно передать **явные синтетические значения** (PowerShell):

```powershell
$env:COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES = "90"
$env:COOKIE_MANUAL_RESCHEDULE_CUTOFF_MINUTES = "30"
$env:COOKIE_MANUAL_OWNER_CANCEL_CUTOFF_MINUTES = "0"
$env:COOKIE_MANUAL_OWNER_RESCHEDULE_CUTOFF_MINUTES = "45"
pnpm demo:local
```

В bash/zsh:

```sh
COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES=90 \
COOKIE_MANUAL_RESCHEDULE_CUTOFF_MINUTES=30 \
COOKIE_MANUAL_OWNER_CANCEL_CUTOFF_MINUTES=0 \
COOKIE_MANUAL_OWNER_RESCHEDULE_CUTOFF_MINUTES=45 \
pnpm demo:local
```

Для отключения удалите соответствующую переменную до следующего запуска (PowerShell: `Remove-Item Env:COOKIE_MANUAL_RESCHEDULE_CUTOFF_MINUTES`; bash: `unset COOKIE_MANUAL_RESCHEDULE_CUTOFF_MINUTES`). Не используйте унаследованные `COOKIE_STAGING_*` для настройки launcher. Эти примеры не являются продуктовыми значениями или настройками салона: [#285](https://github.com/tim8es/cookie/issues/285) требует отдельной tenant-scoped реализации. Публичная запись и worker/provider acceptance остаются отдельными gates.

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

Для legacy owner-link процедуры используйте [telegram-owner-auth-staging.md](telegram-owner-auth-staging.md). Для самостоятельной регистрации через email/Telegram и бизнес/клиентского онбординга используйте [self-service-auth-staging.md](self-service-auth-staging.md): там описаны opt-in flags, BotFather OIDC callback и mail transport. Bot token, Telegram HMAC и OIDC client secret храните только в Altare secrets. **Локальные synthetic credentials и CDP launcher запрещены на Altare.** Частный staging с синтетическими аккаунтами разрешён; это не разрешает production, публичный пилот или реальные клиентские данные. Если BotFather Allowed URLs, домен или mail transport ещё не настроены, соответствующий вход останется недоступен.

Для управляемой публикации в private staging дополнительно нужен проверенный operator-issued grant и `COOKIE_STAGING_PUBLICATION_MODE=enabled` (см. [staging publication capacity](../delivery/staging-publication-capacity-20261117.md)); не включайте без принятого security review. Customer write flag, cancellation cutoff и public API в этом Altare runbook намеренно не активированы.

После deploy проверьте HTTPS, `/health/ready`, вход/отказ доступа, реальные SQL записи, restart/persistence, логи без secrets, restore на отдельной тестовой DB. Не утверждайте, что deployment проверен, без URL/commit/observed results. Отключите автоматический rollout произвольных feature branches; отдельная staging branch обновляется только после проверки.

## Границы этого изменения

Это интеграционный launcher и runbook, не production readiness. Оформление и создание записи владельцем не подключены. Не добавляется HTTP bypass, не выдаются токены с клиента, не трогаются booking/identity contracts, не включаются provider notifications. CI дополнительно запускает `node scripts/local-staging.mjs verify` (все четыре cutoff отсутствуют) и `node --import tsx scripts/local-staging.mjs verify-demo` (четыре явных синтетических cutoff 90/30/0/45) в разных disposable Docker-проектах. Оба режима проходят один сценарий реального каталога: проверка начального состояния (пусто в QA, одна опубликованная услуга в demo), форма на 1280/375/320 px, создание услуги, проверка строки и receipt в БД, переключение клиента и владельца, отказ без signed proof, чтение сохранённой услуги после нового входа. Demo дополнительно проходит доступный жизненный цикл: клиент создаёт запись, владелец видит её в дневном/недельном календаре на 320/375/1280, клиент отменяет запись, владелец видит обновлённый статус; подтверждаются ID, статус и цена в PostgreSQL, logout и отсутствие временного browser storage после операций. Дополнительно проверяются HTTP capability и отображение сроков для четырёх операций; это не исполнение всех четырёх мутаций в launcher smoke. Все cutoff — явные synthetic CI inputs, не продуктовые defaults. Оба runtime проверяют 404 для legacy `/demo`; существующие UI fixtures по-прежнему проверяются отдельным браузерным smoke. Это одна функциональная проверка паритета, не полное сравнение всех экранов. Это проверка самого launcher на Linux, не Windows GUI или Altare. Independent review и exact-head CI обязательны; remote staging verification относится к рабочему runtime #203, а не к отдельному демосервису. Ручной запуск на Windows требует локальной проверки; #203 остаётся открытым.
