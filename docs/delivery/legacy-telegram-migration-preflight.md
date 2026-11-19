# Legacy Telegram migration preflight (#358) — engineering candidate

Stacked on #354. This is a read-only internal assessment, not a migration, login,
consent flow or production operation. No runtime endpoint, CLI, schema change or
public package export is added.

The same trusted Mini App verifier and per-fingerprint advisory lock as existing
login/linking paths are used. Proof is checked again after waiting. One SQL
statement reports the current snapshot, including revoked history. The result
contains a classification only, no identity/tenant IDs, fingerprints or tokens.

| Classification | Meaning |
| --- | --- |
| invalid-proof | Proof is invalid or no longer current |
| consumed-proof | The proof digest already exists in either exchange store |
| no-legacy-link | No matching historical link |
| ambiguous-legacy-history | More than one historical mapping, even if revoked |
| inactive-or-unverified | No unique active verified and consented legacy link with active membership |
| global-link-conflict | Existing global mapping for the fingerprint or legacy identity |
| other-legacy-link | Another legacy fingerprint for that identity |
| additional-memberships | Membership scope is not exactly the original single membership |
| existing-email-provider | Existing email credentials must be reviewed, not merged |
| role-scope-review | No active role, unsupported role/scope, or owner mismatch |
| candidate-for-review | Narrow candidate for additional operator/security review only |

Conservative review scope is a proposed engineering choice, not an approved
migration policy. Additional memberships, historical rows, other provider
bindings and revocation provenance need explicit review. The read-only result
does not reserve the mapping, consume the proof or grant any rights; a future
write must independently verify proof, authorization, scope, concurrency,
migration/rollback and revocation in its own transaction. Existing legacy and
global login behavior remains unchanged.

PG regression uses only synthetic records: eligible customer, unknown Telegram,
no global account creation and existing one-time legacy exchange, then revoked
link. Unit tests exercise refusal classifications and post-lock proof expiry.
No real data or rollout; HTTPS Telegram acceptance remains open.

The initial single-organization scope is deliberately narrowed to active
organization-wide client/actual-owner assignments without another email
provider. Admin/staff/location-specific role mappings are not intrinsically
invalid; they require a separate scope review. Preflight rejects proof digests
already consumed by either legacy or global exchange. The PostgreSQL regression
inserts conflict fixtures under savepoints and rolls them back, including
email credentials, global link collisions, historical duplicates and removed
roles. This does not modify the production migration contract or consume any
credential.

## Proposed preparation transaction (not activation)

Candidate migration 0054 introduces an internal review-only table with a
restrictive composite FK to the exact legacy tenant/Identity/link. An
operator-authorized caller must supply those expected IDs, separate consent
confirmation and a fresh signed proof. The function remains unexported from
the package entrypoint and has no runtime caller. It locks the fingerprint,
checks the exact live link and membership with NOWAIT SHARE locks, repeats
preflight and proof verification, then records only request ID, link/identity
references, proof digest and time. Same exact eligible request can replay;
conflicting request/proof IDs cannot create a second receipt. Any transaction
failure rolls back the receipt. It does not reserve or consume login proof,
change roles, create a global mapping or grant authentication. No activation
may trust an old receipt, including one whose link has since been revoked.

This intentionally adds no policy for automatic migration. The receipt is
point-in-time review evidence, not a lock on future provider/role changes.
Authorization of human operators, lifecycle/retention and FK cleanup,
revocation provenance, activation locking/atomicity and the shared Mini App/OIDC
flow require further review. Reconcile migration numbering before stacked merge.
Synthetic PG tests check exact identity/link, same-request retry, conflict,
rollback, post-revocation refusal and existing legacy login after preparation.

## Proposed internal activation candidate

Migration 0055 adds explicit source provenance to the global Telegram link.
The internal activation function requires a prepared request, independently
approved consent and a distinct fresh signed proof. NOWAIT locks fence the
exact original Identity, organization, membership, link and current roles,
then preflight is repeated. Activation consumes the distinct proof, creates
only a global provider mapping for the SAME identity, revokes old tenant
bearers and records an audit event atomically. No session is issued until a
separate fresh global login. Existing customer/booking IDs are not changed.
An existing migrated mapping can acknowledge an exact retry without issuing
any credential; a revoked source cannot be reactivated by login.

Only the exact live migrated source bypasses the legacy login guard. Legacy
exchange rejects a global mapping or previously consumed global proof.
Source link mutation/revocation or original membership disable permanently
disables the migrated mapping and revokes its Telegram identity sessions in
the same transaction; other providers' sessions are not revoked by this
trigger. No automatic conversion, API or operator CLI is registered. Full
revocation concurrency, OIDC, browser and operator authorization/retention
acceptance remain required before release; this is a policy proposal.

Additional PG regression covers activation while a membership UPDATE holds
its lock (NOWAIT denial), rollback after activation writes, simultaneous
same-request activation, fresh trusted Telegram subject login and replay,
original membership disable/re-enable without Telegram resurrection and
issuer-specific session revocation. The trusted-subject test is not a real
OIDC network callback; the independently issued synthetic email token is
not a password login. Provider status excludes permanently disabled migrated
Telegram mappings. No operator/runtime activation or real deployment.

A compiled Chromium regression now attempts the internal migration only after
real customer create/cancel/receipt recovery. It asserts same customer and
Identity linkage, both existing bookings and unchanged durable booking/receipt/
outbox projection, no repeated enrollment, cookie restoration on reload
without proof replay, and rejection of the migrated cookie after original
link revocation. The activation is a test process call against the isolated
CI database, not an exposed operator/API action. The new browser evidence
requires exact-head CI; real Telegram and Altare remain unverified.


## Current integration port (review-only)

This candidate follows #368's `0053_identity_session_expiry_cleanup.sql` and reserves `0054` and `0055` only on this isolated integration branch. The source SQL is unchanged; no deployed migration history has been verified or rewritten. Reconcile all subsequent refresh ordinals against the final manifest and the staging database's applied filenames/checksums before any deployment. No operator endpoint or real account migration is authorized.
