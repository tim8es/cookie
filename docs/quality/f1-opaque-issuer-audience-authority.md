# F1 #165 — exact issuer/audience binding for Cookie session authority

Status: candidate implementation, isolated stacked PR on #173; no public authentication, production deployment or live Telegram.

## Gap and contract

PR #173 (current-main-based) fixes the reproducible revoke-first Booking race and locks Policy/Membership → Telegram Link → Session in a DB transaction. But its final locked session lookup originally checked only SHA-256 token digest + tenant/identity + revocation/expiry, without comparing the issuer/audience that the authoritative provider had verified. No confirmed exploit arises from this in the currently unmounted synthetic HTTP adapter; it is an explicit trust-boundary hardening requirement before public AuthN.

A real `PostgresOpaqueTelegramSessions.verifyBearerToken` now returns server-owned `opaqueSessionAuthority`: exact SHA-256 digest, issuer, audience. HTTP AuthN independently recomputes SHA-256 from the header token and denies malformed/mismatched provenance before constructing TrustedActor. The transaction-held `assertActiveOpaqueSession` additionally matches issuer and audience at both locator and final `FOR SHARE` check, so no already-verified alternate issuer/audience can authorize the wrong session.

## Compatibility and restrictions

Existing synthetic fake verifier ports that do not return authority metadata retain the old digest-only behavior to avoid changing opt-in F1 harness semantics. **These ports are not eligible for public rollout.** A real Cookie provider always supplies both labels; routing/production composition must eventually require this stronger contract and prohibit legacy fakes. Never accept session authority from user JSON, headers other than the authenticated bearer, or query parameters. Raw bearer tokens and credentials are not logged or stored.

The original independent QA #162 revoke-first regression remains untouched. Expiry QA #172 and membership-disable deadlock QA #174 are separately stacked on #173 and must be verified with this hardening in the final combined state. Previous green CI at #173 or #171 does not establish this branch's correctness.

## Evidence gates

- `apps/api/test/opaque-session-issuer-audience.unit.test.ts`: validated provider claims, digest mismatch, malformed labels, cross-tenant and legacy synthetic boundary.
- `apps/api/test/opaque-session-authority-lock.integration.test.ts`: real PostgreSQL 16 positive issuer/audience and negative same-digest/wrong-issuer-or-audience while preserving exact-session row locks, revoke ordering and original assertions.
- Legacy `opaque-telegram-sessions.integration.test.ts` and `telegram-trusted-links.integration.test.ts` assert the exact extended provider DTO including digest + issuer/audience, not a weakened partial match.
- Require full exact-head CI: read-only Prettier, lint, typecheck, unit, PG migrations/integration, backup/restore, worker, Svelte/web and browser smoke.

Release remains blocked by #113 security review, #144 required status checks, combined branch QA and production/legal gates. No deployment, payment, real PII or commercial pilot is authorized.
