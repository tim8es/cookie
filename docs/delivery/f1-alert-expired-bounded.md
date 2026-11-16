# F1 #154 — bounded operational alert delivery expiry cleanup

**Status:** synthetic-only technical reliability increment stacked on
PR #149. This is separate from the ordinary Outbox queue bounded by
PR #159. No alert provider or production process is enabled.

The alert delivery `claimOutboxAlertDeliveries` now bounds the
pre-claim sweep to **25 expired final-attempt leases** per call:
`ORDER BY lease_until, transition_id LIMIT 25 FOR UPDATE SKIP LOCKED`.
Only eligible, unlockable rows change to `dead` with
`LEASE_EXHAUSTED`; any overflow stays leased and becomes eligible
for the next sweep. This preserves the independent claim/ACK fencing,
attempts, retry, journal identity, failure codes and lease tokens.

This is a per-call maintenance budget, **not** a cleanup deadline,
production SLA or a separate background service. An exhausted queue
requires subsequent claim calls to finish dead-letter maintenance.
No external side effects or real operator notifications are enabled.

The real PostgreSQL 16 test seeds 70 expired final-attempt delivery rows
and one pending transition with the normal journal trigger. It proves
that the first call obtains and ACKs the ready transition while moving
only 25 expired rows to `dead`, and that two later calls move the
remaining 25 and 20. It records actual observed claim duration and
counts without treating the sample as an operational benchmark.
A final poll is idempotent.

No migration, Booking, Identity, UI, CI or normal Outbox worker changes.
External idempotency/authorization, provider consent, real PII, backups,
RPO/RTO and production release gates remain **OPEN**. Issue #154's
separate ordinary queue portion is tracked in PR #159; HIGH issue
#150 / QA #157 remains unaddressed by this change.

## Final main-branch reconciliation (2026-11-16)

This PR now targets `main` including the reviewed synthetic Cookie session security fix #173 (commit `a3f498a222fe43d0484389e93e5097cd0a76e7ae`). It contains BOTH the original SKIP LOCKED isolation change and the bounded expired-lease maintenance follow-up. No test assertions or runtime implementation have been altered in this retargeting commit. A new exact-HEAD GitHub F1 CI run is required before merging; previous green results on the older stacked base cannot substitute for current-main integration. No external provider, real messages or production rollout is enabled.

## Combined-base check after ordinary Outbox merge (2026-11-16)

Ordinary Outbox #159 was merged into `main` as commit `82dd319dbfbb7e23ad19513c3cf076486fb672e2`. This alert-queue PR remains independent, but its earlier [CI #43922271773](https://github.com/tim8es/cookie/actions/runs/43922271773) tested the prior main. A fresh exact-HEAD full F1 CI is required on the updated base before #161 can merge. Source SQL and QA assertions are unchanged. No live notification provider or production deployment.
