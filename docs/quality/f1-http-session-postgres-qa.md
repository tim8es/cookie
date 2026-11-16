# Independent QA — HTTP session boundary backed by PostgreSQL 16

**Scope:** [F1 identity/tenancy Issue #18](https://github.com/tim8es/cookie/issues/18) and [test strategy](../quality/test-strategy.md). New synthetic integration test only; no production API, authorization, DB schema, CI, or frontend edits.

## Why this gate is necessary

Current `apps/api/src/app.ts` exposes health probes and an **opt-in** `GET /v1/organizations/:tenantId/session-context` adapter. The normal `apps/api/src/main.ts` does **not** install a bearer-token verifier; thus the protected route is absent by default. There are **no booking mutation HTTP endpoints** in the current `main`; the separate domain-booking integration tests prove internal commands but not HTTP retries or browser/API idempotency.

Existing `session-context.unit.test.ts` tests Fastify with mock permission guards; existing `identity.integration.test.ts` tests PostgreSQL authorization without HTTP. This test connects those previously separate boundaries using Fastify `inject`, a **test-only trusted session verifier stub**, `postgresTenantPolicyGuard`, and a real PostgreSQL 16 pool with migrated schema.

## Security/behavior coverage

- Missing, ambiguous or malformed bearer credentials and expired/invalid verifier output produce HTTP 401 **without** consulting/auditing DB policy.
- One real synthetic identity belongs to two distinct Organizations; a verified tenant-A session cannot select tenant B through path, query string, or forged `X-Tenant-ID`/`X-Identity-ID`/`X-Correlation-ID` headers. Tenant mismatch is 403 before policy read, not a cross-tenant audit.
- Location-only role assignment does not permit reading organization-wide context. Changing the assignment to organization-wide scope enables the route; response contains **only the server-owned tenantId**.
- The same identity can be accepted independently inside tenant B, with an unrelated role and membership.
- Disabling a tenant-A membership, role or role assignment is reflected by the **next** real PostgreSQL policy check and cannot revoke access to the other tenant. A verified identity with no membership is denied.
- Every actual policy evaluation is inserted into the authoritative `cookie_identity.authorization_audit` with an allow/deny reason and a fresh server-generated correlation ID. Unauthenticated and cross-tenant URL requests do not create a policy audit row; no unverified token or forged correlation becomes an audit record.
- Explicitly asserts `POST /v1/bookings` remains 404: **do not mark HTTP booking idempotency implemented**.

## Limitations / next release gates

The verifier in this test is **deliberately a stub** returning synthetic already-verified sessions; it is not a production JWT/OTP/Telegram verifier. This test proves the protected Fastify adapter + real PostgreSQL authorization path only, **not** real credential cryptography, replay/refresh/revocation of bearer tokens, CSRF, production sessions/cookies, live HTTP sockets or booking routes. No live personal data, payment or paid provider calls.

Execution: the existing F1 PostgreSQL integration test glob automatically includes `apps/api/test/session-context-postgres-http-qa.integration.test.ts`. Keep this PR separate from frontend and backend agents; no auto-merge. CI run evidence to be linked in the PR after a verified green run.
