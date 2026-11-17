# Cookie F1: real Workspace overview read (private staging only)

Status: **Draft engineering candidate**, independent security review required.
Stacked on verified Telegram owner AuthN PR #221 and operator provisioning #217.

## User value

After HMAC-verified Telegram login, an owner can retrieve the real
PostgreSQL-backed salon name, filial names, IDs and configured IANA time zones:

`GET /v1/organizations/:tenantId/workspace-overview`

Response:
```json
{
  "organization": {
    "organizationId": "server-verified-uuid",
    "displayName": "Staging salon"
  },
  "locations": [
    {
      "locationId": "database-uuid",
      "displayName": "Main studio",
      "timeZone": "Europe/Moscow"
    }
  ]
}
```

This endpoint is only registered when the main server has explicitly enabled
its verified Telegram owner sessions; ordinary startup remains health-only.
The `tenantId` URL parameter must exactly match the server-verified Cookie
session tenant, and successful authorization requires
`organization.context.read` granted by active Membership+RoleAssignment
inside one transaction using `requireTenantPermission`. Session/link/
membership/role revocation locks last through the read commit. The result
includes **no** Customer, Booking, staff PII, raw bearer or internal audits.

No mock data is returned. Zero branches is an empty array; more than
100 branches returns a safe 503 without exposing partial data. All results and
denials are `Cache-Control: no-store` and `Vary: Authorization`.

## Limits and next work

This is **read-only**. Creating services/staff/schedules in the browser,
actual owner onboarding without an operator, all public Booking functionality,
cross-browser customer booking links, notifications, live Telegram provider,
rate limiting, PII/hosting/legal approvals and independent security gates
(#113, #165, #175, #37, #38) remain open.

The browser PR #225 is separately owned. It can consume this endpoint in a
later independent PR, without making a fake successful Booking state.

PostgreSQL tests use synthetic HMAC-signable initData and verify real
Postgres tenant scoping, multiple branches, role revocation, bearer revocation,
unknown/foreign tenant rejection and fail-closed default route registration.
