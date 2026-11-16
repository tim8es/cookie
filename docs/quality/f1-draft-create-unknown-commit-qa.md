# F1 independent QA — lost COMMIT acknowledgement in draft-creation workflow

**Scope:** [Issue #20](https://github.com/tim8es/cookie/issues/20), implementation [PR #92](https://github.com/tim8es/cookie/pull/92), and previous independent QA [PR #94](https://github.com/tim8es/cookie/pull/94). Pure test/evidence addition. No backend, frontend, SQL migration, CI or production changes.

## Failure mode and scope

PostgreSQL may durably commit a request, approval, or rejection while the caller fails to receive its acknowledgement. The caller sees an ambiguous network error (e.g. `ECONNRESET`), not a confirmed failure. Retrying with a **new** idempotency key could duplicate work. The dedicated `schedule-draft-create-unknown-commit-qa.integration.test.ts` test simulates three *separate* lost-acknowledgement boundaries after real PostgreSQL `COMMIT` operations and reconnects via a healthy connection.

The simulation awaits PostgreSQL's successful COMMIT, drops the physical pooled connection, and returns synthetic `ECONNRESET`. This models **committed transaction / lost response**, not a live socket cut during COMMIT, and never claims production network fault coverage.

## Expected durable outcomes

| Operation | State after lost response | Same-key recovery |
| --- | --- | --- |
| Draft request submission | One pending request; exactly one requested Outbox event; no ShiftWindow | Original request ID and original pending receipt, no duplicate |
| Owner approval | Request applied; exactly one inactive draft, creation audit and receipt; exactly one applied Outbox event | Same stored `createdDraft` without re-running the change policy callback |
| Owner rejection | Request rejected; no additional ShiftWindow; exactly one rejected Outbox event | Original rejected receipt, no duplicate event |

Additional checks reject mutated submission payloads under the same key, reject a different owner decision key after a terminal status, and verify event `requestId` references for two independent requests.

## Constraints and release gates

- Test-only facade; synthetic UUIDs, identities, Organization, StaffProfile, assignment, and shift dates.
- Existing `apps/api/test/*.integration.test.ts` CI glob automatically runs the new test against real PostgreSQL 16.
- Browser/HTTP retry behavior, genuine network ambiguity around COMMIT, real session AuthN, load/lock contention, production DB failover and external delivery deduplication are **not** proven by this test.
- This PR remains Draft until owner review. Do not merge automatically or edit another agent's sources.

**Acceptance evidence:** see the GitHub Actions run linked from the PR after CI finishes.
