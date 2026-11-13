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
