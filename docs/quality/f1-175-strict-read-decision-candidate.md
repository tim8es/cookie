# F1 #175 — proposed strict Workspace role-revocation consistency

**State: PROPOSED / OWNER DECISION REQUIRED; Draft PR, do not merge.**
This is a clean current-`main` replacement for superseded overlapping stacks #179/#182/#176. It uses existing F1 server-only synthetic routes; no public API provider, real PII, payment or deployment.

## Why the candidate exists

The previous `workspace-context` read held a transaction-scoped Cookie bearer/link authority lock but obtained Membership/RoleAssignment/Role scope through an ordinary unlocked SQL snapshot. Independent real PostgreSQL16 QA [#176](https://github.com/tim8es/cookie/pull/176) was **RED** for the proposed strict contract: after successful policy SELECT, role revocation committed first, then the response could still return HTTP 200 with old organization/location metadata. This is **not automatically** a production exploit or proof that a read-first snapshot contract is invalid.

Two interpretations remain possible:

1. **A — Strict transaction-boundary linearization (proposed).** Acquire Organization → Membership → Assignments → Roles `FOR SHARE` locks before Telegram link and Cookie session; hold until the protected read transaction COMMIT. Revoke-first returns 403/no metadata; read-first holds locks and revoke waits. This is the source candidate below.
2. **B — Explicit snapshot/read-first semantics.** A read that successfully selected policy before a concurrent revoke may finish with the old scope. Require a separate clear authorization linearization point, revoke-before-SELECT negative cases, and frontend capability/metadata cache invalidation on 403 and organization/location switch. Do not silently weaken the previous strict regression.

Issue [#175](https://github.com/tim8es/cookie/issues/175) requires an owner/security selection of A or B. This candidate must not be merged simply because its tests are green.

## Minimal clean implementation

- Exports existing internal PostgreSQL `lockPolicyRows(client,actor)`; no changed logic in Booking mutation guard.
- Adds **one await** before `assertActiveOpaqueSession` in the single `workspace-context` read transaction. The transaction holds all policy/link/session locks until COMMIT, avoiding the earlier Session→Membership deadlock.
- Copies the original deterministic independent role-revoke QA test from #176 **byte-for-byte** (Git blob `342302318473e08746676cd9c475c1944856d7e1`) and its evidence note.
- Does **not** overwrite historical #173 session/issuer/audience hardening from `main`. Its base is current `main`, unlike the old stacked PR #179.
- No migration, workflow, auth provider, real Telegram, external network, frontend or Booking business source changes.

## Gates

Require exact-head full CI (PostgreSQL 16, original RED→GREEN, Booking revoke/expiry and cross-tenant regressions, Svelte browser and compiled worker), review after final `main` advances, lock-order deadlock audit, UI sensitive cache invalidation and owner decision A/B. Previous #179 [CI #43919139176](https://github.com/tim8es/cookie/actions/runs/43919139176) and #182 [CI #43921062574](https://github.com/tim8es/cookie/actions/runs/43921062574) are historical evidence of the old stack, **not** PASS for this new candidate.

Security #113/#165, branch-protection #144 and legal/PII/production gates remain independent. No production rollout.
