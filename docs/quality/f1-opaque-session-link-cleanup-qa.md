# F1 #153 — current-main session retention and trusted link deletion gate

**Status:** standalone Draft integration candidate; synthetic tests only.
This is not a scheduled job, public API or approved retention policy.

This branch starts from current main `53de65ae8e7b833e1fc7ff756943c78430ca216e` (after merged opaque
bearer provenance, Telegram link migration, Outbox #150 and other F1
security fixes). The source adapter, original PostgreSQL tests and
retention note are copied **byte-for-byte** from [PR #160]
(https://github.com/tim8es/cookie/pull/160), previously based on a
stale main. The original 7,200-second minimum proof digest retention
and 1–500 row cleanup cap are unchanged.

The additional independent PG16 test verifies the now-current trusted
Telegram link schema (`0023_telegram_trusted_identity_links.sql`):

- Membership disable revokes an old linked session without deleting it.
- Direct membership deletion returns `blocked-by-dependencies`, and
  rolls back the attempted session deletion because a trusted link
  retains a restrictive composite Membership foreign key.
- Direct link deletion while an opaque session references the link
  fails with PostgreSQL `23503` (no silent cascade).
- With an eligible 4-hour-old synthetic session, a bounded cleanup
  can purge its bearer and consumed proof digest; the link can then
  be explicitly deleted; finally disabled membership deletion
  succeeds. This is a technical order-of-operations proof, **not** an
  approved user-data erasure workflow.

Real proof exchange anti-replay, SKIP LOCKED contention, revocation,
and the original role-FK rollback remain covered by the **unchanged**
original #160 tests. Enforce a full exact-head F1 CI against the
latest main; earlier #160 CI does not prove current-main compatibility.

**Not delivered:** automated production scheduler, supervised cleanup
frequency, issuer/bot clock skew alarms, real legal/PII retention policy,
authorized multi-tenant account deletion orchestration or a real
Telegram provider. A raw token must never be logged or exposed.
Do not convert FK RESTRICT to CASCADE or activate cleanup without
separate security/legal/operational review. Issues #153, #113 and
#144 and F2 production gates remain open.
