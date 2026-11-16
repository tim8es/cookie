# F1 synthetic workspace and staff schedule HTTP read adapter

**PROPOSED, synthetic and explicitly opt-in.** Stacked on PR #102/#100.
No production/customer endpoint, token issuer, real PII, paid provider or
automatic route enablement. This closes the first portion of #18/#19/#20/#22
without granting new role permissions.

## Wire contract

Defined in `packages/contracts/openapi/f1-synthetic-v1.yaml`.

1. `GET /v1/organizations/:tenantId/workspace-context` with verified Bearer
   session: returns `{organization:{organizationId,displayName},locations:
   [{locationId,displayName,timeZone,canCreateBooking,canReadBookings}]}`.
   The tenant is **always** taken from the verified session, not from a
   caller-supplied string. The path must match exactly. The result only
   contains branches for which the current active membership has location
   scoped `booking.create` or `booking.read`, evaluated via the existing
   centralized PostgreSQL policy snapshot. At least one authorized location
   is required; no permission returns 403 without organization metadata.
   A location without configured IANA time zone is not create-bookable.
   Staff/Customer ownership is not inferred from role display names or IDs.
   The F1 synthetic response is bounded to max 100 branches.
2. `GET /v1/organizations/:tenantId/locations/:locationId/staff/:staffId/schedule?from=&to=`
   with verified session: returns `{locationId,staffId,staffName,timeZone,
   shifts:[{startAt,endAt}],blocked:[{kind,startAt,endAt}]}`. Requires the
   **explicit** `schedule.read` permission scoped to the real tenant,
   location and StaffProfile; owning `booking.read` alone is insufficient.
   Inputs are full UTC instants, with half-open windows and maximum 7-day
   interval. Only active shifts/breaks/exceptions intersecting that range
   are included; output is limited to 500 shifts and 500 blocks. Missing
   active staff assignment or configured time zone yields 404.
   This is a schedule **read**, not a free-slot guarantee or write approval.

The server uses existing `loadPolicySnapshot`/`evaluateAuthorization` for
workspace capability filtering and `requireTenantPermission` for each
staff schedule read. There is no ad hoc SQL role string comparison or
trusting of `X-Actor`/`X-Tenant` headers. All SQL is tenant-scoped.

## Integration and failure semantics

The extension is mounted **only if** `createApp(..., {
syntheticWorkspaceReads:{pool,verifier}})` is explicitly supplied by the
synthetic test harness. Standard `main.ts` continues to return 404 for these
routes. `401 UNAUTHENTICATED` means no valid session; `403 ACCESS_DENIED`
means wrong tenant, no authorized branches or missing scoped schedule.read;
`400 INVALID_REQUEST` means malformed/wide query;
`404 STAFF_NOT_FOUND` means unavailable staff assignment;
`503 BACKEND_UNAVAILABLE` hides PostgreSQL/driver internals.

The existing `GET .../catalog` supplies active service/staff offers with
server base-price snapshots. `GET .../availability` supplies actually
computed, non-reserving bookable slots including cross-branch occupancy.
Frontend should not assume raw shifts are free slots or that catalog
base price is a finalized F2 discounted Quote.

**Unresolved release gates:** real AuthN and customer link, tenant lifecycle
and entitlement source, proper dedicated schedule mutation / publication
locking evidence, per-role field visibility, promotion-based Quote, public
availability rate limiting, RLS/least privilege, and genuine network retry
tests. No customer-facing pilot is authorized.
