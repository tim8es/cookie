# Refresh session families (#359) — proposed internal candidate

Stacked on #360. Candidate migration 0055. No runtime caller, HTTP cookie,
access issuance, package entrypoint export or approved production policy.

- Separate 256-bit random `ir_` credential; SHA-256 only at rest. No role
  or tenant data; issuer/audience and Identity are fixed per family.
- Explicit installation-owned idle and absolute seconds; no defaults.
  The stored idle duration and absolute expiry are fixed when created.
  Database clock is authoritative, absolute expiry cannot slide.
- Serialize on family row; re-read consumed credential AFTER lock.
  Exactly one current credential, historical digests retained for detection.
  Successful rotation consumes old digest and inserts next generation in
  the same transaction. Replay of a consumed live credential revokes the
  entire family. Unknown/foreign/expired/revoked credentials deny.
- Logout primitive revokes by any exact known credential of the family,
  including a rotated one. It does not revoke existing identity_sessions
  because no access tokens are minted by this candidate.
- Transaction callback must return only after acknowledged COMMIT; do not
  expose rotation results before commit or blindly retry uncertain commits.

Strict replay revocation is a proposed security policy for review: simultaneous
refresh from multiple tabs or a lost response can force fresh login. Do not
activate until an independently reviewed browser coordination protocol exists.
No grace window or persisted plaintext response. Retention and cleanup must
retain consumed digests until the family can no longer be used; no scheduler.

Next: fresh authenticated provider continuation (not bearer-only binding),
transactional provider provenance and credential epoch checks, short-lived
family-linked access issuance, revoke existing family access on logout/replay
and password recovery/Telegram provider revocation. Design lock order across
provider, family and session updates; older access tokens must not outlive
family revocation. Then cookie/HTTP/browser integration and private HTTPS
acceptance. Current short-lived session behavior remains unchanged.

PG integration exercises rotation, replay/concurrency, scope, separate
families, logout by historical credential, idle and absolute cap, rollback,
hashed persistence and absence of access issuance. Exact-head CI required.

## Synthetic access integration (0056)

A separate candidate service uses ONLY issuer cookie-refresh-candidate and
synthetic-test audience, not accepted by the deployed runtime. Access mint
and refresh rotation commit together, with expiry capped by family limits.
Composite FK binds access to exact Identity/issuer/audience/family. A family
revocation trigger revokes all its access generations and records audit events
atomically. Same-bearer renewal is prohibited for family-linked access.
Synthetic PG tests exercise runtime-issuer denial, generation revocation,
independent family isolation, concurrent rotation/logout and rollback.

An access-only revoke is not family logout. Provider-aware issuance and
recovery/revocation lock order, access-cookie semantics and browser protocol
remain required before using a real issuer or mounting endpoints. Existing
production-shaped provider sessions still have their original behavior.

## Telegram provider continuation (0057)

Separate synthetic candidate accepts only fresh verified Mini App login for an
existing global Telegram identity, shares proof-consumption and migration
checks with the normal login path, and atomically binds a refresh family to
the exact provider fingerprint and Identity. No bearer-only conversion or
additional registration. Access still uses the isolated synthetic issuer.
The database constraint explicitly forbids the live runtime issuer for this
source. Provider locks precede family locks; NOWAIT contention fails closed.
Original migrated-source revocation disables the exact family and all access
generations through existing transactional triggers. The test exercises a
real migrated synthetic customer, proof replay, rotation, runtime issuer
denial, source revocation and retention of unrelated email-origin access.

Runtime fresh OIDC continuation, real issuer, provider lifecycle/retention,
family logout routed from HTTP, browser rotation serialization and approved
lifetime/replay policy remain open. No operator, API or deployment activation.
