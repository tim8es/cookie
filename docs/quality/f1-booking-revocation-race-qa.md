# Security QA gate — revocation racing with an in-flight Booking command

**Scope:** F1 internal CreateBooking, RescheduleBooking and CancelBooking, [Issue #18 Identity/Policy](https://github.com/tim8es/cookie/issues/18), [Issue #21 Booking](https://github.com/tim8es/cookie/issues/21). Only a new PostgreSQL 16 integration test and this report; no production identity/booking code or migration changes.

## Risk / expected security contract

Current `loadPolicySnapshot` reads membership, role and assignment under ordinary MVCC without acquiring policy row locks. `requireTenantPermission` is currently called near the beginning of a transaction, while actual durable Booking writes can happen later after an entitlement or business-policy callback.

A concurrent administrative revocation can commit **after** that policy read but **before** the authorized command's Booking/receipt/Outbox mutation commits. Sequential revocation checks (PR #98) do not cover this interval.

**Safe outcomes, either acceptable:**

1. Authorization/policy rows are locked until the command has completed. The administrative revoke is serialized **after** the mutation commits; the command may succeed because it precedes revocation.
2. Revocation commits while the command is paused. Before durable mutation/COMMIT the command must recheck policy with a synchronization protocol, reject with `ACCESS_DENIED`, and leave business state unchanged.

**Unsafe outcome:** Revocation demonstrably commits while command remains paused, then the command succeeds and commits after access was removed. This is a distinct concurrency race, not a replay of a previously committed receipt.

## Reproduction / deterministic checkpoints

`apps/api/test/booking-revocation-race-qa.integration.test.ts` seeds only synthetic Organization, owner membership, owner role and assignment, location, bookable staff, service, customer, UTC shift and an initial confirmed booking.

The test pauses inside an injected **trusted test-only** callback which executes *after* the command's initial authorization but *before* its Booking write:

| Booking operation | Checkpoint callback | Concurrent administrative revoke |
| --- | --- | --- |
| CreateBooking, new slot | entitlement callback | `memberships.active=false` |
| RescheduleBooking, existing Confirmed | reschedule policy callback | `roles.active=false` |
| CancelBooking, existing Confirmed | cancellation policy callback | `role_assignments.active=false` |

A second real PostgreSQL connection tries to revoke in a separate transaction with a finite 500 ms `lock_timeout`. If the update is blocked, the test releases the command first and accepts serialized execution; it then completes revocation. If the update commits, the test releases the paused command and **requires `ACCESS_DENIED`**. This accepts both valid orderings without inducing a permanent deadlock.

The assertion aggregates all three observed results so each operation yields evidence even when the first is vulnerable. The test deliberately fails CI on an unsafe concurrent authorization outcome. This is a **red release gate**, not an assertion that the current unsafe behavior is acceptable.

## Remediation considerations (proposal, not approval)

- Current permission enforcement must have a well-defined linearization point with administrative revocation. Locking the relevant Membership/Role/RoleAssignment rows consistently until the command transaction commits, with a documented lock ordering, is one possible approach; evaluate blocking, multi-role dependencies and deadlocks.
- A late recheck alone may still allow a `READ COMMITTED` race between final check and `COMMIT`; do not silently claim this closes the gap without concurrency evidence.
- Preserve tenant/branch isolation, audit and idempotent receipt invariants. Add regression coverage for policy update racing with Booking, scheduling and opt-in HTTP adapters as those integrate.
- A revocation that commits after the authorized command has committed cannot retroactively roll back the earlier command. Token AuthN/Customer ownership/production HTTP security remains separate.

**Expected status until fixed:** Draft PR with failing PostgreSQL integration gate; no merge. Do not soften the test, skip it or substitute a happy-path result merely to make the workflow green.
