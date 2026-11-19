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
| no-legacy-link | No matching historical link |
| ambiguous-legacy-history | More than one historical mapping, even if revoked |
| inactive-or-unverified | No unique active verified and consented legacy link with active membership |
| global-link-conflict | Existing global mapping for the fingerprint or legacy identity |
| other-legacy-link | Another legacy fingerprint for that identity |
| additional-memberships | Membership scope is not exactly the original single membership |
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
