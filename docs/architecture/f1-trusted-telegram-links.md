# F1 — Trusted Telegram user ↔ Identity links (synthetic only)

**Status:** implemented as a server-internal **candidate**, not approved live auth, customer linking or launch. Source: ADR-0004, #18/#66, and the prior Telegram proof/session PRs #137/#141/#146.

## Why this is a separate security boundary

A valid Telegram Mini App HMAC verifies only the Telegram account's identifier, **not** a Cookie organization, customer, membership or consent. PR #146 already supports one-time Telegram proof → randomly generated, SHA-256-stored, revocable Cookie bearer, but requires `ResolveVerifiedTelegramLink`. Returning hard-coded identities from test callbacks cannot constitute a real account link.

## Current implementation

- Migration `0023_telegram_trusted_identity_links.sql` adds `cookie_identity.telegram_identity_links` with immutable tenant/Identity composite FK, server-supplied verification and consent timestamps, and revocation timestamp. It does **not** create a trusted workflow to record consent. There is no public write endpoint.
- Store a 32-byte HMAC-SHA256 fingerprint of the Telegram numeric ID with a **separate stable secret per Telegram bot**, never the raw Telegram ID, bot token, username, name, email, phone or initData string. The secret is injected at runtime and MUST be managed/rotated securely; an all-zero test key is never safe for real use. Proposed fingerprints are not user account IDs.
- `createPostgresVerifiedTelegramLinkResolver` accepts only a previously HMAC-verified Mini App proof, does a bounded `FOR SHARE` PostgreSQL read for existing non-revoked verified+consented links, and returns exactly one `(tenantId,identityId,telegramLinkId)` or `null`. It cannot create/activate a link, and it refuses ambiguous multi-organization mappings instead of choosing the first organization or trusting request parameters.
- A second active link to a different Identity for the same Telegram user in one tenant violates a partial unique index. Cross-tenant Identity links violate the composite FK. The schema allows future explicitly confirmed new links after revocation without resurrecting old sessions.
- The existing opaque session store locks a returned link in its issuance transaction and binds the issued session with a new composite FK to **that exact tenant, Identity and link**. Verification fails when that link is revoked. The revocation trigger also durably marks all sessions of the link revoked. New active links cannot revive sessions from an old link.
- Existing synthetic #146 callback sessions (which return no `telegramLinkId`) remain intentionally test-only and unlinked for compatibility. **They must never be registered as a public verifier or used to grant a customer booking.**

## Still blocked / not claimed

1. A trustworthy consent and link-provisioning workflow, with proof of account ownership, conflict recovery, logged operator authorization, privacy review, and explicit unlink.
2. A reviewed tenant chooser for one Telegram account in multiple Cookie organizations. Until then *ambiguous exchange denies*; this deliberately prioritizes safety over convenience.
3. A tenant-scoped `Customer` table/link and server-proven ownership. The current F1 schema has no `Customer` entity. A link to Identity **does not** permit access to customer bookings.
4. Cookie session delivery via secure cookie/CSRF policy (or approved bearer transport), production secret management, authorization per mutation, transactional link-revocation enforcement for in-flight Booking commands, entitlement policy, rate limiting, abuse monitoring and operational deletion/retention.
5. Production rollout, real Telegram provider secrets, real PII, real customers and commercial pilot still require separate approval.

The resolver intentionally is not mounted by `apps/api/src/main.ts` and does not alter `apps/web/src/lib/api.ts`. Tests use synthetic identities, bot token, fingerprints, and PostgreSQL 16. Full CI and security review required before this candidate is treated as a completed F1 control.
