# F1: transactional revocation authority for opaque Cookie sessions

Status: IMPLEMENTED IN ISOLATED STACKED PR, **not merged**. Synthetic-only; no live Booking routes or production deployment.

## Confirmed defect and invariant

Independent PostgreSQL 16 QA in PR #162 / Issue #165 demonstrates a revoked bearer or revoked Telegram identity link passing HTTP preflight before the corresponding Booking mutation. The original QA test is retained byte-for-byte in the parent branch.

**Invariant:** If session/link revocation commits first, every protected DB Booking operation using that bearer must deny and roll back Booking, command receipt and Outbox. Conversely, a revoke racing an already authorized in-flight DB transaction cannot commit until that transaction releases its locks. No check-then-write-only authorization.

## Fix

- The Postgres opaque bearer verifier returns **server-derived** SHA-256 token digest, issuer and audience as internal authority provenance; never raw credentials, client JSON or query parameters.
- HTTP `verifyTenantActor` validates the provenance's structure and attaches it only to a `TrustedActor` built from the verified server session.
- `requireTenantPermission` revalidates the exact tenant+identity+issuer+audience+token hash under a transaction-scoped `FOR SHARE` row lock. If linked to Telegram, it locks and verifies the active link **before** the session row.
- Existing Organization, Membership, Assignments and Role locks are acquired **before** link/session locks. This aligns with membership-disable and Telegram-unlink revocation UPDATE/trigger order.
- Both missing and expired/revoked sessions fail closed; a changed link binding cannot be accepted across the unlocked reference read and final locked recheck.
- The same guard is invoked by CreateBooking, RescheduleBooking, CancelBooking and policy-protected Booking read paths; the caller **must** hold a single explicit PostgreSQL transaction until it finishes. Session-context-only or non-transactional guard calls do not establish a protected mutation gate.

## Verification

Parent PR #162 contains the independently-authored, previously RED PG16 test:

```sh
TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci \
  pnpm exec tsx --test --test-concurrency=1 apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts
```

Require full exact-head F1 GitHub Actions: lint, Prettier, TypeScript, unit, PG16 migrations/integration, worker and browser gates. Do not mark PASS from source inspection. Additional concurrency tests should hold an authorized command's DB lock while revocation attempts an UPDATE, then assert serialization and clean final state.

## Boundaries / follow-up

- Existing synthetic verifier ports without opaque provenance are unaffected; they do **not** automatically gain transactional revocation protection. A live Cookie session provider **must** supply authoritative provenance, and the public route must reject unsupported providers before activation.
- The mutation lock establishes authorization and revocation ordering, not a guarantee that a session cannot expire naturally before a very long operation completes. Bound transaction duration and implement fresh session-expiry policy before a public release.
- Existing role/membership lock-order review and #113 must continue; provider registration, customer ownership, legal/PII checks, and production deployment remain forbidden until explicit approval.
- No external providers, customer PII, secrets, payments or production configuration are changed here.
