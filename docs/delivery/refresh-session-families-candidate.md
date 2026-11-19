# Refresh session families (#359) — proposed internal candidate

Stacked on #360. Candidate migration 0056. No runtime caller, HTTP cookie,
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

## Synthetic access integration (0057)

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

## Telegram provider continuation (0058)

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

## Isolated HTTP transport candidate

The inject-only Fastify adapter is deliberately absent from app/runtime
registration. Its separate candidate cookie is host-only, Secure, HttpOnly,
SameSite=Strict, with server-bounded Max-Age. Only access credentials go in
JSON; all operations require same-origin Fetch Metadata and the explicit
session header. Login requires fresh signed Mini App proof. Rotation accepts
no body/query/TTL and optionally requires the prior access credential to
belong to the exact refresh family. Fresh-page restoration can rotate without
an access token. Logout always requires both cookie and matching family
access, including older/expired access while its digest remains stored.
It revokes all family generations server-side and never sends a cookie-delete
response that could erase a subsequent login. Denials/uncertain commits do
not emit Set-Cookie. A dead cookie may remain until expiry/replacement.

PostgreSQL + inject coverage tests login, restoration, same-Identity separate
family mismatch, exact-family logout, unaffected parallel family and no
refresh credential in JSON. HTTP unit negatives cover CSRF metadata, duplicate
cookies, malformed inputs, TTL override and uncertain transaction response.
Not yet a browser protocol: login/rotate responses can still arrive out of
order, and strict replay can force reauthentication after response loss.
Cross-tab single-flight, lost-response behavior, stored digest cleanup and
real HTTPS WebView acceptance must be resolved before runtime activation.
Integrate with current-main auth stack #368 only after separate review.

## Browser coordination candidate (not mounted)

HTTP rotation and logout now require a matching non-authorizing random family
UUID even when restoring without a previous access bearer. The cookie remains
the actual refresh authority; a family UUID alone grants nothing. A stale
or mismatched cookie cannot be adopted after a tab switch or late response.
The test-only browser controller serializes login, rotate and logout with one
origin-wide exclusive Web Lock, rechecks the family after acquiring it and
stores only a nonsecret family/fence value (not a token, identity or role) in
localStorage. An interrupted operation leaves a durable pending/blocked fence;
rotation is never blindly retried and other tabs do not silently adopt another
family. Fresh explicit login is needed to clear the fence. Lack of Web Locks
or accessible storage disables this candidate; no unsafe fallback.

The proposed nonsecret storage policy, strict replay recovery, explicit
account-switch/logout behavior and renewal lead time require review. The
controller is not wired into the application or a timer. Unit tests use
shared lock/storage doubles and PG HTTP tests reject a wrong family handle.
Real multi-tab Chromium, lost-response and WebView acceptance remain open;
UI must check current authority on focus/storage events and before protected
reads. This does not revoke an old family merely by signing into another;
that policy and server-side cleanup remain separate.


## Combined integration candidate

Migration ordinals 0056–0058 follow the isolated legacy-migration port (0054/0055). Original SQL contents are unchanged; staging applied migration history has not been verified. No runtime entrypoint, approved lifetime policy or deployment is implied by this port.
