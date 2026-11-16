# F1 role-revocation authorization during Workspace reads

## Confirmed RED baseline

Independent QA-only [PR #176](https://github.com/tim8es/cookie/pull/176), exact SHA `2fbad83301623cb73bc1a4878361664a30a4a675`, real PostgreSQL 16 [CI #43918414828](https://github.com/tim8es/cookie/actions/runs/43918414828): 46/47 integration tests PASS, **1 security assertion FAIL**. A role was set inactive and committed while the opt-in Workspace GET held a previously loaded policy snapshot. Response was HTTP **200 instead of required 403** and disclosed organization/location metadata. No public production endpoint or real user data exists.

## Fix and contract

The Workspace's root `workspace-context` read uses a single PostgreSQL transaction with multiple possible per-location permissions (either booking.create or booking.read). Previously it called `loadPolicySnapshot` without acquiring the policy row locks used by the mutation handlers. The revoked role could update while this read held a stale, already-fetched SQL result.

Expose the internal transactional `lockPolicyRows(client, actor)` helper from the Identity PostgreSQL module and call it at the start of this read transaction **before** `assertActiveOpaqueSession`, then load and evaluate the policy snapshot. This preserves Organization → Membership → RoleAssignments → Roles → Telegram link → Cookie Session locking, avoids Membership→session inversion, and holds all locks until read COMMIT/ROLLBACK.

A revoked role that commits first must deny, without metadata. If the protected read's lock wins, the competing revoke cannot commit until that read commits, and a previously authorized 200 is valid. Both orders are permitted; stale authorization after earlier revoke is not.

## Regression and limits

The independent, previously RED `apps/api/test/workspace-role-revoke-read-qa.integration.test.ts` is copied **byte-for-byte** from QA #176, without weakening assertions, into this isolated source-fix branch so full real-PostgreSQL CI can verify it. The same test must be independently rerun against the final merged base. This does not prove all possible deadlock interleavings or authorize public/customer data access; #113 and #165 remain security gates.

Mandatory CI: exact-head lint/Prettier/TypeScript, all unit/PG migrations and integration (including QA #176), backup/restore, worker smoke, Svelte/browser smoke. No production deployment/real data/paid provider.

## Consolidated policy-candidate PR on current main (2026-11-16)

This source branch has been retargeted from superseded canonical #173 to current `main` commit `3833803c554c4e4cd5593e215ed7bb12c494ea77`, after successful Booking #165 fixes, consolidated independent QA, Outbox/CI and 409 browser checks. All existing strict-contract policy locking and independent role revoke-read regression assertions remain unchanged; a new exact-head full F1 CI run must verify the current merged base.

The strict policy is still **PROPOSED, not accepted**: [Issue #175](https://github.com/tim8es/cookie/issues/175) requires the product/security owner to choose transaction-linearizable Workspace reads vs a documented MVCC read-first snapshot policy, plus UI capability cache clearing on forbidden results and tenant switches. This branch is a single staged candidate replacing duplicate old-base #182 and QA-only #176; keep Draft, **do not merge into main until #175 is resolved**. No production/real Telegram/PII/payment/pilot permission.
