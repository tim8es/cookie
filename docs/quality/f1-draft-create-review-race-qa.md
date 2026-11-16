# F1 independent QA — draft creation review race and tenant isolation

**Scope:** [Issue #20](https://github.com/tim8es/cookie/issues/20), latest merged [PR #92](https://github.com/tim8es/cookie/pull/92), and F1 PostgreSQL 16 quality gate. Only a new integration test and this QA evidence document are changed. Neither backend implementation nor frontend/DB/CI contracts are modified.

## Threat model

Two independent Organizations can have the same verified owner identity, manager identity, role names, and caller idempotency key. UUID request identifiers must remain tenant-scoped, and no actor should approve a different tenant's request even when that identity is a valid owner elsewhere.

One owner may also submit an **approve** and **reject** decision for the same pending draft-creation request concurrently. Both decisions are independently authorized; PostgreSQL must serialize them so exactly one wins. A losing response cannot write an inactive shift, audit, receipt, or duplicate outbox event.

## Automated evidence

The new `schedule-draft-create-review-race-qa.integration.test.ts` test:

1. Seeds two synthetic Organizations with separate StaffProfile/LocationAssignment, but shared owner/manager identities and identical submission idempotency keys.
2. Creates one pending request in each tenant and confirms that neither inserts ShiftWindow before review.
3. Rejects a cross-tenant review by a user who is a legitimate owner in *both* organizations, and a review by a location-authorized non-owner.
4. Races distinct owner decisions (`approve` versus `reject`) on the same request using a PostgreSQL connection pool with multiple connections.
5. Requires exactly one committed terminal status, an `ALREADY_DECIDED` error for the loser, and an identical durable receipt when replaying the winner.
6. Checks exactly one initial request event and one winning decision event, with ShiftWindow/audit/receipt present exactly once on approval or absent on rejection.
7. Verifies that tenant B's pending request remains unaffected, can be rejected independently, and never creates a ShiftWindow.

The test runs under the existing `apps/api/test/*.integration.test.ts` pattern when `TEST_DATABASE_URL` is configured. It uses synthetic UUIDs and timestamps, no real customer data, no external channels, and no production deployment.

## Interpretation and remaining gates

A passing PostgreSQL CI run proves the checked **transactional single-winner and tenant isolation** cases, not a universal linearizability guarantee or a production-ready scheduling API. Race tests do not replace session/authentication/HTTP adapter checks, long-running load tests, clock-boundary checks, real user identity verification, or policy changes during an in-flight decision.

Ownership coordination: this independent QA lane does not edit the backend agent's code or the frontend agent's stacked PRs. Any discovered implementation flaw should be reported to the relevant owner for a separate fix.
