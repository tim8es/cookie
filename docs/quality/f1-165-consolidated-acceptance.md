# F1 security acceptance — consolidated #165 QA gate (synthetic only)

Source baseline: canonical backend [PR #173](https://github.com/tim8es/cookie/pull/173), commit `ef36fe28cc745e57dc9b12fb3e2c6c20fcc6480c`. This branch collects independent QA rather than duplicating the server-side implementation.

## Mandatory scenario matrix

| Test | Previously observed evidence | Required on this branch |
| --- | --- | --- |
| Exact Cookie bearer revoked after valid HTTP AuthN | Independent original #162 RED | 401/403, zero Booking/receipt/Outbox |
| Cookie session expired after valid HTTP AuthN | Independent QA #172 RED | 401/403, zero Booking/receipt/Outbox |
| Telegram Identity link unlinked after valid HTTP AuthN | Independent original #162 RED | 401/403, zero Booking/receipt/Outbox |
| Positive live synthetic Cookie bearer | QA #178 | HTTP 201 Confirmed |
| Identical idempotency key replay | QA #178 | same receipt, 1 Booking + 1 receipt + 1 Outbox |
| Revoke after successful commit | QA #178 | later replay 401/403, counts unchanged |
| Membership active=false racing locked session | QA #174 | serialized COMMIT, no SQLSTATE 40P01 or unbounded wait |
| Issuer/audience protection | Canonical #173 | exact real provider-authenticated SHA/issuer/audience before protected commit |
| Browser/worker/restore | Existing F1 CI | no skipped mandatory gates |

Independent sources: #172's three-mode test file has been copied **unchanged** from its final QA head; #178's positive HTTP test copied unchanged. #174's regression has unchanged assertions and concurrency checkpoints; its synthetic verifier **fixture only** now includes the correctly authenticated token SHA-256 + issuer/audience required by updated #173 (otherwise a legacy fake Cookie verifier would be denied before reaching the row-lock scenario). No production code or migrations changed in this integration branch.

## Release boundary

Exact-head full F1 CI on this combined source is required. Previous standalone green runs cannot establish combined success. Leave P0 #165 open pending independent reviewer and latest-main merge-ref confirmation. The opt-in synthetic Booking API is not mounted by production API startup; real Telegram/PII, production rollout and commercial pilot remain unapproved.

Workspace role-revocation consistency is a **separate** policy decision in [Issue #175](https://github.com/tim8es/cookie/issues/175) and proposed strict option PR #179. It is intentionally not bundled here to avoid silently ratifying contested read-linearization semantics.
