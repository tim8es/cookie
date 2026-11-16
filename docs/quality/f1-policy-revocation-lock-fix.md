# F1 security fix — tenant policy row locks for transaction-scoped authorization

**Related:** [Security issue #113](https://github.com/tim8es/cookie/issues/113), [QA regression PR #109](https://github.com/tim8es/cookie/pull/109), Identity [#18](https://github.com/tim8es/cookie/issues/18) and Booking [#21](https://github.com/tim8es/cookie/issues/21).

**Status:** PROPOSED for review; no F2/production authorization claim.

## Confirmed failure before fix

A Booking command reads a currently active Membership/Role/RoleAssignment through `requireTenantPermission`. It can then pause in its mandatory trusted entitlement/business-policy callback while another PostgreSQL client commits an administrative revocation. Without protected policy rows, the command can resume and commit Booking, an idempotency receipt and Outbox **after** revocation has committed.

The real PostgreSQL 16 test in PR #109 reproduced all three variants, with a single failed security integration test and 31 other integration tests passing.

## Implementation

`packages/platform-identity/src/postgres.ts` now acquires `FOR SHARE` row locks, in a fixed order, **before reading the authorization snapshot and before logging an authorization preflight**:

1. Organization row (owner identity / ownership).
2. Current actor's Membership.
3. Current actor's RoleAssignment rows, ordered by stable ID.
4. The corresponding OrganizationRole rows, ordered by stable ID.

`FOR SHARE` permits multiple concurrent guarded commands but conflicts with policy UPDATE/DELETE. The caller supplies the same transaction-scoped PostgreSQL client through authorization, business-policy callback, Booking mutation, Outbox and COMMIT. Therefore:

- If a revocation commits **before** a command takes its relevant row lock, PostgreSQL returns the committed inactive state and permission is denied.
- If a command takes the row lock **first**, administrative revocation cannot commit until after its business transaction commits/rolls back.
- A successful permission check cannot be reused after an external revocation without the corresponding transaction holding its policy lock.
- Unrelated tenant and actor rows are not intentionally globally locked.

The read-only `loadPolicySnapshot` function remains unchanged and is **not** itself a mutation authorization boundary. New guarded command handlers must call `requireTenantPermission` inside their own transaction. A connection used outside an explicit `BEGIN` holds locks for the duration of each statement only and **does not establish transaction-long protection** for later mutations.

## Evidence and review gates

- Red test [PR #109](https://github.com/tim8es/cookie/pull/109) covers real concurrent Membership, Role and RoleAssignment deactivation during CreateBooking, RescheduleBooking and CancelBooking.
- This PR also adds a direct PostgreSQL lock test covering held row locks, release after commit, denial after revoke and unrelated-tenant progress.
- No optimistic unlocked recheck, schema migration, token verifier, PII, external provider or production startup changes.
- **Open review gate:** consistent lock ordering with every admin policy update, transfer-owner and scheduling command; deadlocks/latency under production-like load; impersonation/guest/customer identity; durable denied-access audit, which still rolls back on denied command transaction; HTTP adapters remain opt-in and synthetic.
- This branch is **stacked on QA PR #109**. It is not meant to merge by itself before the regression test on its base; tests must pass in the final composed head.
