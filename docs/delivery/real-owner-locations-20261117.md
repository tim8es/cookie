# F1 — владелец создаёт реальные филиалы

**Status:** engineering Draft, only synthetic accounts/private staging.
Base: real Telegram owner session #221, owner provisioning #217, real catalog
#228 and staff #230. This slice does not touch the production rollout.

## End-to-end scenario

1. An already verified Telegram owner visits the **Филиалы** tab in the real
   owner workspace (not the sessionStorage mock).
2. GET `/v1/organizations/:tenantId/locations` reads actual PostgreSQL
   `cookie_tenancy.locations`, returning
   `{locations:[{id,displayName,timeZone,createdAt}]}`.
3. Owner creates a new branch from **exactly** `{displayName,timeZone}`.
   `timeZone` must be a valid server-recognized IANA zone; SQL syntax alone
   is not authoritative. The server canonicalizes and stores the chosen zone.
4. `POST /v1/organizations/:tenantId/locations` returns 201 with the
   committed row, 200 for exact same-key replay after uncertain COMMIT, or
   409 when the same actor/key is reused with changed data.
5. Reload/reopen with fresh Telegram proof: the branch remains in PG. The
   Staff tab's actual API will include it among tenant Locations for future
   *draft* staff assignments, without creating bookable shifts.

## Trust, durability, limits

- New migration `0028_tenant_location_create.sql` only adds a durable
  idempotency receipt FK and owner-only `location.read/create` permissions.
  Owner provision receives these permissions for newly created tenants.
- TenantId comes only from the previously verified opaque Cookie bearer,
  matched against the URL; browser cannot choose Identity, role or owner.
- `requireTenantPermission` and SQL insert/list run within the same DB
  transaction. Policy, Telegram link and exact bearer locks last until COMMIT,
  including denied attempts. Responses are no-store/private and sanitize
  storage errors. No customer contact or Booking data in Location DTO.
- Up to **100** locations per Organization (including the first provisioned
  branch). A tenant-scoped advisory transaction lock serializes distinct-key
  creates and prevents concurrent over-limit successful inserts.
- Input requires NFC nonblank name (≤200 chars) and valid IANA zone. The
  API does not accept client-provided Location ID or active/bookable switches.
- Same-key replay does not create duplicate branch; conflict and server/network
  failure cannot produce UI fake success. The key is retained for retry unless
  the form input changes. UI uses memory-only Cookie session, not localStorage.

## Tests and release gates

`apps/api/test/real-owner-locations.integration.test.ts` with real PG16/17:
signed synthetic Telegram Mini App proof, durable owner provisioning, default
404 and missing bearer 401, foreign tenant 403, same-key concurrent POST 201+
200, changed request 409, invalid IANA or injected owner 400, accurate list
and receipt counts, 100-branch cap, current role reduction, bearer logout.

`apps/web/src/lib/locations-api.test.ts`: strict DTO, tenant-scoped bearer,
no-store/no-referrer transport, idempotency, failures 401/403/409/503/offline
and expired session, no synthetic fallback. Runtime in regular health-only
mode continues to omit these routes.

**Not delivered:** postal address/contact, scheduling/publishing shifts,
staff-service assignment activation, customer booking URL, real client PII,
entitlements, real Telegram bot, Altare deployment, payments, production.
Booking concurrency security issues #113/#165 and Workspace #175 remain
gates. All PRs are Draft until exact-head CI and independent review.
