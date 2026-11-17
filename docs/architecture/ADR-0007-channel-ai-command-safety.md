# ADR-0007 — Независимые каналы, AI и внешние агенты

**Статус: PROPOSED** · Issue #31, #34, #40, #41 · REQ-011,016,017.

## Важное разделение
Channel transport (Telegram, web chat, future messenger), conversation/orchestrator (scenario/AI), authorized tool runner и domain capability — независимые слои.

## Команды
Чат и голос конвертируются в структурированные намерения, но mutation исполняет только domain API с tenantId, actor, permissions, idempotency и audit. Confirmable actions требуют подтверждение пользователя. AI не получает SQL или секреты, не принимает окончательные решения о доступности слота.

## Масштабирование
Добавление messenger adapter не меняет booking; ограниченный provider API может не иметь Mini App/кнопок/голоса, поэтому promise одинакового **бизнес-процесса**, а не пиксельного UX.

## MCP
Отдельный auth-aware адаптер к тем же инструментам. Не публичный анонимный доступ. Rate-limits/scopes/confirmations и безопасные read operations; эксперимент после исследования спроса.

## Voice
Отдельный transcription/voice provider, согласование персональных данных и срока хранения аудио. Транскрипт — непроверенный ввод, никогда не источник auth.

## Fail closed
При падении AI/канала запись через web продолжается; при невозможности определить actor/tenant изменение не исполняется.

## Telegram admin and file commands (DEC-116 / DEC-117)
Same bot, distinct customer/admin context; verified identity link + active scoped membership and server session, explicit tenant selection, private admin chat, revalidation on each protected read/commit/callback. File input untrusted; preview then explicit confirmation using shared Data Exchange capability; no AI or direct DB. Sensitive exports gated and delivered via protected short-lived authenticated link rather than raw attachments by default. See [specification](../product/tabular-and-telegram-admin.md), #252/#253. Revocation/security/legal gates unchanged.
