# F1: интеграция защищённого обзора организации

**Status:** Draft, synthetic engineering only. Builds on the previously
tested Workspace read #227 and the owner full-stack slice #232.

The existing `workspace-overview` read API is preserved, reusing the
PostgreSQL transaction, verified opaque Telegram session and
`organization.context.read` checks from #227. This integration merges
both Git histories and explicitly composes the route in the authenticated
runtime alongside Catalog, Staff and Locations. Default startup still
does not register any of these protected routes.

The real owner workspace has an additional **Обзор** tab. It reads the
real organization name and branch time zones through `GET
/v1/organizations/:tenantId/workspace-overview`. The result is strictly
validated, including exact session tenant equality, bounded unique
UUID branch IDs, valid timezone or explicit legacy null, and names.
The tab displays an error instead of mocked or stale data if the response
cannot be verified. Refresh cancels prior in-flight fetch; unmount and
credential expiry clear the active request. On this tab, local protected
metadata is cleared at bearer expiry. No new localStorage/sessionStorage
state, synthetic credentials, or new permissions are introduced.

Navigating to actual Locations, Catalog and Staff tabs is supported.
Default Services view remains unchanged to avoid breaking existing
onboarding and the independently owned real-browser E2E #236.
No fake Booking counters, availability, scheduling, activation, prices,
or real public data are shown.

New web transport unit tests + existing #227 real PG integration
cover mismatched tenant, invalid/duplicate/oversized location DTO,
valid static zone/null, expired credentials, 401/403, unavailable
service, cancellation signal and sanitized error behavior.
Exact-head full CI + security review remain mandatory. The true
end-to-end browser run for this new tab is a separate acceptance
step; the real-browser #236 candidate should extend after integration.

No actual PII, real bot, production/Altare deploy, or public pilot.

Current-main reconciliation: the backend is already merged (#227, #247); do not reintroduce the older adapter. Owner session expiry now belongs to the App shell rather than only the Overview tab: all protected tabs unmount and the in-memory bearer is cleared on deadline, including tab focus/visibility/pageshow after suspension. Deterministic timer/resume/cleanup tests are included. This is local expiration handling, not a guarantee of immediate remote revocation detection or production security approval.
