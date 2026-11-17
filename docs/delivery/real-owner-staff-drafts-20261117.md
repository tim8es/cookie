# F1 real owner staff drafts — end-to-end slice

**Status:** Draft engineering candidate for private controlled staging with
synthetic accounts only. Parent PR #228 provides real authenticated owner
Services (PostgreSQL API + web UI); this PR adds the next independent feature.

## User-visible behavior

After verified Telegram login, the real owner UI displays a second
**Мастера салона** section below the real Services catalog. The owner can
fetch an empty or nonempty staff list from PostgreSQL and create a profile
with display name and separate professional title:

- `GET /v1/organizations/:tenantId/staff` → `{staff: StaffProfileRecord[]}`
- `POST /v1/organizations/:tenantId/staff` with the 36-character random UUID
  `Idempotency-Key` and **exactly** `{displayName,positionTitle}`
- POST → `201` new / `200` exact same-key replay / `409` changed input;
  invalid or role-escalating body → `400`
- Response record: `{id,displayName,positionTitle,active,bookable,createdAt}`

`StaffProfile` is an organization-scoped business resource, **not** a Cookie
`Identity` or login account. The role `owner` is not inferred from position
title. Newly created masters always have `active=true,bookable=false`. No
LocationAssignment, ServiceAssignment, shift window, role assignment or
customer permission is created. Therefore the UI cannot imply any valid
Booking slot or client access.

## Server contract

- Migration `0027_staff_profile_create.sql` adds the nullable descriptive
  `position_title` field and durable staff idempotency receipts; previous
  profiles remain compatible. New/existing Organization owners receive
  `staff.profile.read` and `staff.profile.create` permissions without
  granting them to staff/admin roles. A role reduction revokes access.
- `apps/api/src/staff-http.ts` exposes the two routes **only** if the API
  bootstrap has verified Telegram Cookie sessions. Both run scoped
  `requireTenantPermission` inside the exact SQL transaction, preserving
  membership/role/Telegram-link/session revoke locks through COMMIT.
  Untrusted tenant URL is matched against the actual bearer tenant, never
  accepted as a body field.
- Writes use PostgreSQL advisory lock + receipt uniqueness with
  (tenant, verified identity, idempotency key) scope. Exact retry returns the
  same persisted staff ID, even after an uncertain network error. All
  protected responses set `Cache-Control: no-store`, not cacheable by proxies.
- No automatic request retry. The web remembers a pending key until fields
  change or server confirms a durable response. Invalid DTO, 401/403, 503 and
  network errors do not become a fake success state.

## Evidence and release exclusions

Run exact-head F1 lint/format/types/unit + PostgreSQL 16/17 integrations,
persistent Docker staging smoke, compiled web and browser checks. The
integration test covers verified Telegram proof + owner provisioning, empty
list, cross-tenant denial, concurrent same-key creation, changed-key-body
conflict, blocked role/identity injection, staff nonbookable, permission
reduction, bearer logout and default 404 when auth is disabled.

**Not implemented:** staff assignment to branch/services, staff login,
schedule, availability, real public Booking, pricing overrides, notifications,
public pilot/real customer data, legal compliance, or Altare production
rollout. Booking security #113/#165 and Workspace #175 still require
separate acceptance. PR remains Draft pending review and merged-base CI.
