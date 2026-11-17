# Cookie: ручное тестирование настоящего API (локально и Altare)

**Только F1 engineering / synthetic staging.** Не используйте настоящие данные клиентов, production DB, настоящий bot token или коммерческие платежи в локальном сценарии.

## 1. Локально (Windows / macOS / Linux)

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

Открытое окно — рабочий кабинет. В обычной вкладке без signed proof вход намеренно не работает. Для повторного входа после истечения 15 минут, logout или F5 нажмите Enter в терминале; это создаёт новый proof. Команды `owner` и `client` переключают разные тестовые Identity в одном tenant, `demo` открывает изолированный `/demo`. Для явного отзыва старого bearer нажмите «Выйти» перед сменой роли; иначе он может действовать до expiry. Ctrl+C завершает API и тестовый браузер. Данные PostgreSQL сохраняются. Повторный запуск возвращает тот же тестовый tenant; ключи и настройки хранятся в игнорируемой `.tmp/manual-staging/state.json`. Не публикуйте этот файл, не переносите на Altare. Не удаляйте state при сохранении DB.

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
4. В интеграционной ветке опубликуйте смену, введите `client` в терминале, выберите филиал, услугу, мастера и слот, подтвердите запись; проверьте «Мои записи», затем `owner` → календарь. В локальном runtime доступна и реальная отмена своей записи: в «Мои записи» нажмите «Отменить запись», подтвердите действие и проверьте статус в календаре владельца. Для синтетического QA явно задан cutoff 60 минут (не коммерческое правило). Выберите запись более чем за час до начала. Перенос, public Booking и worker/provider acceptance остаются отдельными gates.

В интеграционной ветке `/` всегда использует API, `/demo` — mock. Для ручной проверки реального backend используйте только команды выше. Не переносите тестовые ключи или данные из локального UI на реальный сайт.

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

Это интеграционный launcher и runbook, не production readiness. Оформление и создание записи владельцем не подключены. Не добавляется HTTP bypass, не выдаются токены с клиента, не трогаются booking/identity contracts, не включаются provider notifications. CI дополнительно запускает `node scripts/local-staging.mjs verify` с отдельным disposable Docker-проектом: реальный compiled runtime + signed owner/client + `/demo`. Это проверка самого launcher на Linux, не Windows GUI или Altare. Independent review + настоящий локальный Windows/Docker/browser run + remote staging verification обязательны; #203 остаётся открытым.
