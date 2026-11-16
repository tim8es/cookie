# F1 — транзакционная авторизация opaque Cookie bearer (#165)

**Статус:** независимый opt-in PostgreSQL guard + синтетические тесты. **НЕ интегрирован** в `CreateBooking`/`CancelBooking`/`RescheduleBooking`, HTTP adapter или production bootstrap. Задачи #165 и #113 остаются P0 **BLOCKED**, пока реальные защищённые команды не используют этот контракт и неизменённый QA-тест PR #162 не станет зелёным.

## Контракт входа

`requireOpaqueSessionCommandAuthority(client, authority)` принимает **уже открытый PostgreSQL PoolClient внутри той же транзакции, что и Booking mutation**. `authority.bearerToken` должен быть извлечён только из предварительно криптографически проверенного server-side Authorization header; `actor.tenantId` и `actor.identityId` — из верифицированного AuthN, а `issuer/audience` — из конфигурации провайдера. Ни одно поле не приходит из JSON, query string или пользовательской tenant selection. Нельзя использовать через autocommit `pool.query()`: блокировки будут сняты до Booking COMMIT.

Не хранить/логировать raw bearer; в PostgreSQL передаётся только SHA-256. Неправильный токен, mismatched tenant/identity/issuer/audience, неактивная Membership, отозванная доверенная Telegram-связь, отозванная или просроченная сессия → `OpaqueSessionAuthorityDeniedError` без разглашения токена. Ошибки БД должны откатывать команду и fail closed.

## Линеаризация

1. Без блокировки прочитать идентификатор связанного Telegram-link по **точному** digest и scope. Это только locator, **не разрешение**.
2. В транзакции заблокировать активную Membership `FOR SHARE`.
3. Если сессия привязана к Telegram-link, заблокировать этот конкретный non-revoked link `FOR SHARE`.
4. Заблокировать точную non-revoked, non-expired opaque session `FOR SHARE` и перепроверить привязку link. Держать все row locks до COMMIT/ROLLBACK защищённой команды.

Порядок Membership → Link → Session учитывает существующие триггеры: disable Membership и unlink Link обновляют session, а точечный revoke обновляет session. При **revoke-first** следующий guard отказывает. При **command-first** отзыв соответствующей строки не может закоммититься до окончания защищённой транзакции. Не использовать чужой tenant or link. Требуется дальнейший полный анализ lock ordering вместе с Role/RoleAssignment, StaffProfile и Booking (#113) для исключения циклов под нагрузкой.

## Проверки

Реальная PostgreSQL 16 интеграция с синтетическими Identity, Membership, link и session: разные tenant/Identity/audience, malformed bearer, expired session, bearer revoke, link unlink, Membership disable/re-enable. Для command-first конкурентный UPDATE на отдельном соединении с `lock_timeout` обязан вернуть `55P03`; после COMMIT guard ревокация проходит, повторная авторизация отказывает. Никакой браузерной, реальной Telegram и пользовательской эксплуатации.

## Блокеры до включения

- AuthN адаптер должен сохранять server-owned bearer/issuer/audience для самой транзакции, а не только преждевременно вычисленные `TrustedActor` claims. Нельзя принимать свежую «подтверждённую» actor identity из body.
- Backend должен вызывать guard **до policy, idempotent receipt replay и всех write** в Create/Cancel/Reschedule; для protected reads также нужен атомарный контекст. QA PR #162 два режима revoke-first должен стать GREEN без ослабления.
- Этот guard проверяет expiry при защищённой проверке, но не гарантирует, что длительная транзакция завершится *до* истечения TTL по настенным часам. До production нужен deadline на транзакцию и review near-expiry/commit-time semantics.
- Отдельно проверить порядок локов tenant policy (#113), session revocation, duplicate receipt и прекращение ожидающих транзакций при timeout; тесты этой ветки не являются доказательством отсутствия deadlock во всех interleavings.
- В этом PR нет production deployment, внешних провайдеров, реальных ПДн, оплаты или коммерческого пилота.
