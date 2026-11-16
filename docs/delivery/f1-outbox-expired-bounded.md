# F1 #154 — bounded ordinary Outbox expired-lease sweep

**Status:** isolated synthetic-only infrastructure increment stacked onto
ordinary Outbox row-lock isolation PR #147; not a production rollout.

## Limit and progress

The ordinary `claimOutbox` previously swept all expired final-attempt
leases before attempting to claim any ready event. Even with `SKIP LOCKED`,
an arbitrarily large expired backlog could monopolize one claim cycle.

The pre-claim maintenance CTE now uses a fixed **25-row budget** with
`ORDER BY lease_until, id LIMIT 25 FOR UPDATE SKIP LOCKED`.
It is applied **per claim call**, not globally, and is restricted to the
existing `topic` filter when set. Only unlocked, eligible final-attempt
leases are marked `dead` with sanitized `LEASE_EXHAUSTED`; all others
remain leased for a future claim. This deliberately trades immediate bulk
dead-lettering for bounded per-cycle write/lock pressure and timely
selection of unrelated ready events. Subsequent polls provide eventual
maintenance; with no future polls, no autonomous cleanup occurs.

No change to regular ready-work claim size, backoff, lease durations,
fencing, at-least-once semantics or tenant authorization. This cap is
a technical safety default, **not** a measured deployment/SLO threshold.

## Real PostgreSQL evidence

The integration test seeds 70 synthetic expired final-attempt events in
tenant A and 4 expired events of another topic, plus one ready event of
the first topic in tenant B. One claim must deliver the ready event while
moving **exactly 25** matching expirations to dead. Successive calls sweep
25 more, then 20; other-topic leases are preserved by filtered sweeps and
reaped by an unfiltered call. Actual claim duration and counts are
recorded in CI output without asserting an invented latency threshold.

This is only the **ordinary** event-queue half of Issue #154.
Alert delivery's separate preliminary sweep in PR #149 still requires
its own bounded increment and regression. Neither PR fixes the
separately verified HIGH stale-lease handler-start race (QA PR #157).
No real provider, PII, payment, deployment or commercial-pilot access.

## Final main-branch reconciliation (2026-11-16)

This PR now targets `main` including the reviewed synthetic Cookie session security fix #173 (commit `a3f498a222fe43d0484389e93e5097cd0a76e7ae`). It contains BOTH the original SKIP LOCKED isolation change and the bounded expired-lease maintenance follow-up. No test assertions or runtime implementation have been altered in this retargeting commit. A new exact-HEAD GitHub F1 CI run is required before merging; previous green results on the older stacked base cannot substitute for current-main integration. No external provider, real messages or production rollout is enabled.
