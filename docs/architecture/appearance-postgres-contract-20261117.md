# Cookie Appearance — PostgreSQL draft/publish v1 boundary

**Status:** IMPLEMENTED STORAGE SLICE (isolated controlled staging), not a public release.  
**Issue:** #223; depends on shared Appearance contract PR #226; real owner and public routes depend on #203 and #222.  
**Date:** 2026-11-17.

## Persisted structure

Migration `db/migrations/0030_appearance_revisions.sql` creates one versioned Appearance aggregate per `tenant_id` under `cookie_appearance.organization_branding`. `tenant_id` is an FK to `cookie_tenancy.organizations`. The database stores distinct **draft** and **published** configs/revisions; timestamps and constraints prohibit half-published rows or a published revision greater than the current draft. No public read API or PostgreSQL grants are introduced.

The business-module API is exported only through `packages/domain-appearance/src/index.ts`:

- `readTenantBrandDraft(client, trustedTenantId)` returns a **non-published** safe default (revision 0) if nothing was saved.
- `saveTenantBrandDraft(client, trustedTenantId, expectedRevision, rawConfig, ownership?)` validates `BrandConfigV1`, uses a tenant-row lock and expected revision compare-and-swap, then increments the draft revision. The initial `INSERT ... ON CONFLICT DO NOTHING` ensures two concurrent initial drafts cannot both succeed.
- `publishTenantBrandDraft(client, trustedTenantId, expectedRevision, ownership?)` validates the stored config again, rechecks asset ownership and atomically copies the draft to the published fields. Repeating publication of the same revision is idempotent.
- `readPublishedTenantBrand(client, trustedTenantId)` returns **only** an already-published revision, or `null`. It never falls back to the draft or synthetic data.

All operations use the **caller-owned** `PoolClient`; they do not open their own independent transaction, generate customer privileges or permit a client-submitted tenant to act as verified identity.

## Security boundary (mandatory for production route)

**This PR does not expose an HTTP endpoint.** The authenticated route must:

1. Verify the bearer/Telegram session using the existing trusted Identity provider and bind `actor.tenantId` server-side. Never trust `tenantId` from a caller's JSON.
2. Begin a PostgreSQL transaction, call `requireTenantPermission` for Appearance-specific read/edit/publish operations on the same client, and keep the active-session revocation guard within the same transaction.
3. Call the store on that client and COMMIT/ROLLBACK, producing bounded 400/401/403/409/503 errors with no SQL/secret detail.
4. For public reads, resolve a **published** URL slug through an approved server-side tenant selector. A UUID in an anonymous URL is not authority. Only expose the `readPublishedTenantBrand` projection, never draft or asset metadata.
5. Until an asset-service callback checks actual tenant ownership and MIME-safe uploaded assets in the same transaction, **reject** drafts/publication referencing any non-null logo/background asset IDs. An opaque syntactically valid ID alone must not grant access.

## Test evidence and remaining blockers

PostgreSQL integration `apps/api/test/appearance.integration.test.ts` uses synthetic owner/tenant rows and real migration-backed connections. It checks default-not-published, draft save, revision mismatch, two independent tenant states, repeat publish idempotency, private edits not changing published appearance, transaction rollback, concurrent draft compare-and-swap, and fail-closed asset verification.

The migrations integration test now computes the expected count from checked-in SQL names rather than hard-coding 23/24. This supports concurrent migration-bearing PRs, while the migrator still verifies each applied filename and checksum. **Before merge**, coordinate the ordinal `0030` with active #217 (0025) and #228 (0026) and rerun migration tests on the integrated branch; SQL applied to an environment is immutable.

- [ ] Exact-head CI PASS: lint, format, TS/build, PostgreSQL integration, UI regression.
- [ ] Independent architecture/security review, especially same-transaction authorization and asset ownership.
- [ ] Real authenticated owner HTTP adapter using server session verifier (not synthetic injection).
- [ ] Server-managed asset upload/re-encoding and permission checks.
- [ ] Public path and two-browser real booking/published appearance integration test.
- [ ] Controlled Altare staging verification with restart/backup/restore; no real customer data.

**Acceptance level:** real persistence **module**, not a completed user-facing feature, published salon, production deployment or permission model.
