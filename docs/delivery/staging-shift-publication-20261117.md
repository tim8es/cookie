# F1 controlled-staging shift publication candidate

Stacked on #244. Explicit opt-in COOKIE_STAGING_PUBLICATION_MODE only;
no commercial subscription or public Booking. An owner chooses an existing
future ShiftPlan and explicitly confirms publication. The command reuses
publishShiftInternal (Staff → Shift → permission lock order) with dedicated
non-delegable staging.shift.publish, expected draft revision, existing
create lineage, live staging grant held through COMMIT, active bookable staff,
location and service assignment. The existing cross-location overlap check,
receipts, audit and outbox remain authoritative. No generic schedule.manage
permission grant. Historical disabled shifts cannot be republished.

GET shows persisted active published shifts separately from draft plans.
POST takes shiftId + expectedRevision + Idempotency-Key; retries revalidate
the owner's role/session, grant and active assignment including receipt replay.
Changes are staged/test-only; #113/#165/#175, real PII, entitlement product
policy, deployment, public availability and Booking remain separate gates.

Migration 0033 must be reconciled with other pending branches. No actual
grant was issued and no real user or deployment is affected by this PR.

Current-main reconciliation: use the shared acknowledged SQL transaction port for staging publication and the existing Scheduling transaction helper for owned legacy publication. Preserve caller-managed execution, staff-first locks, exact replay and pre-write permission denial audit. Fresh full F1 evidence required. No public Booking or commercial release approval.
