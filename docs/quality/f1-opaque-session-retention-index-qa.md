# F1 #153 — bounded retention scan indexing (synthetic only)

Status: **PROPOSED, independent review required.** No scheduler or
data deletion activated.

The current opaque-session schema (migration #0022) has a PK on the
token hash and an `(tenant_id,identity_id,expires_at)` partial index for
non-revoked memberships. Proposed maintenance [PR #189]
(https://github.com/tim8es/cookie/pull/189) chooses eligible retired
sessions with `ORDER BY issued_at, token_sha256 LIMIT batchSize
FOR UPDATE SKIP LOCKED`; one query scans all tenants, and the other
also filters `tenant_id,identity_id`. A LIMIT bounds rows *deleted*,
but **does not bound database scans or sort work** without a supporting
access path. This is a source-level scalability risk, not a measured
production latency defect.

Add migration `0024_opaque_session_retention_indexes.sql` with:
- `(issued_at, token_sha256)` for the global oldest-first purge;
- `(tenant_id, identity_id, issued_at, token_sha256)` for the
  membership-scoped oldest-first purge.

A PostgreSQL 16 integration test verifies that **both indexes are
present and can be chosen** for the actual SQL predicate/order/locking
shape, with sequential and bitmap scans temporarily disabled **only
inside test transaction**. It must NOT be cited as a real planner
preference, storage or performance measurement. Production needs
realistic row-volume benchmarks, cardinality/vacuum metrics, index
storage/write overhead budget and an approved online index migration:
normal `runMigrations` wraps each migration in a transaction,
so `CREATE INDEX CONCURRENTLY` is **not** usable in this existing F1
migration runner as-is.

No change to retention cutoff (minimum 7200s), proof replay policy,
API/worker activation, PII, deletion permissions or deployed systems.
The cleanup adapter PR #189 is independent and must be reviewed and
landed separately. Issues #153, #144 and real-data legal/operational
release gates remain open.
