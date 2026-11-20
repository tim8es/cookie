# F1 Staff create recovery after reload — PROPOSED contract

**Status:** PROPOSED — requires explicit owner/security acceptance in [Issue #304](https://github.com/tim8es/cookie/issues/304). This document and its Draft implementation do **not** authorize production, a commercial pilot, real customer PII, or general release. The existing permission, tenant-isolation and opt-in staging restrictions remain in force.

**Implementation candidate:** Draft [#386](https://github.com/tim8es/cookie/pull/386) (positive committed receipt), [#387](https://github.com/tim8es/cookie/pull/387) (mounted UI) and [#392](https://github.com/tim8es/cookie/pull/392) (actor-scoped reload namespace).

## Why tenant-only storage is not acceptable

The browser's verified Workspace owner session contains a tenant ID, an expiring bearer and a browser-binding hint, but **no non-secret authenticated actor ID**. Two authorized people in one organization cannot share an unfinished operation marker. Storing a marker under only a tenant ID risks showing one person's uncertain request to another. Do not put raw actor IDs, a bearer, a request body, names, phone numbers, prices or other business records in browser storage.

## Opt-in server contract

- A dedicated, independent **32-byte secret** is supplied as exactly 64 hex digits in `COOKIE_STAFF_RECOVERY_SCOPE_SECRET_HEX`. Invalid configuration fails startup; an absent value does not mount the new endpoint. Do not reuse Telegram/OIDC/session signing secrets.
- All API replicas of a controlled environment must share the **same secret**. Keep it in a managed secret store, never source, build artifacts, logs or a public deployment manifest. Define a controlled rotation/migration procedure before enabling on any persistent deployment.
- `GET /v1/organizations/:tenantId/staff/recovery-scope` verifies the real bearer and requested tenant, requires an authenticated opaque-session authority and **live `staff.profile.create`** authorization in the protected PostgreSQL transaction, and returns `{ "scope": "<43-char base64url>" }` only after the transaction commits. The HMAC-SHA256 input is domain-separated by `kuki-staff-create-recovery-v1` and NUL-separated server-authenticated tenant and actor identifiers. No caller-provided scope is ever trusted.
- Responses are `Cache-Control: no-store`, `Pragma: no-cache`, `Vary: Authorization`. An absent route returns 404, unauthenticated 401, forbidden 403, unavailable 503. Query parameters are rejected.
- The resulting scope is **not an authentication factor, identity ID, authorization grant, API token or receipt**. Its only purpose is a stable, opaque storage namespace. Authorization is independently enforced again by the actual receipt GET.

## Browser persistence and recovery lifecycle

1. After a fresh verified session, the client reads the server-issued scope. Until that check finishes, Staff creation is disabled; transient/denied/malformed scope replies block new mutation and show a retry action. A genuinely absent opt-in route (404) permits only the earlier **mounted-page** same-key retry, with an explicit warning that reload recovery is unavailable.
2. For a new Staff POST, write **only** the original random UUID idempotency key to this tab's `sessionStorage` key `kuki.staff.create.pending.v1.<scope>` before the network request. Do not store the Staff draft or bearer. If storage is blocked, fall back to explicit mounted-only behavior; never assume persistence succeeded.
3. A server-confirmed create response resolves the attempt and clears that marker. A lost/unknown response retains the original key and immutable mounted form. A follow-up denial cannot disprove an earlier possible COMMIT.
4. After page navigation, reload or a fresh login **as the same actor**, the client first re-verifies authority and gets the scope from the server again. Only then may it load the key in that exact namespace. The screen exposes a *read-only* “Проверить сохранение” action; the key is sent only as `Idempotency-Key` header to `GET /v1/organizations/:tenantId/staff/receipt`, never in URL/query or a background create POST.
5. Only an authenticated `200` response containing exactly `{ "staffId": "<UUID>" }` proves the original tenant/actor/key **committed**. Then the marker can be cleared and Staff/calendar reads refreshed. `404`, `401`, `403`, `503`, transport failure or malformed response mean **unresolved**, not “create failed” or “safe to generate a new key”. No name-based heuristic and no blind retry after reload.
6. Session logout or role revocation must revoke further server reads. A same-tenant different actor obtains a different HMAC scope and cannot access the first actor's receipt. A different tenant also has a different scope. A new login by the *same* verified actor may resolve a marker even after browser bearer rotation, if the original committed receipt and create permission remain valid.

## Deliberate limitations and security decisions still required

- **Secret rotation:** changing the HMAC key makes old marker namespaces inaccessible. It does not delete receipts or prove a failure. Before live activation, choose versioning/overlap or an operator-supported recovery path; do not silently reissue a new Staff create.
- **Multiple tabs:** markers are tab-local. They do not synchronize between tabs, other devices, private sessions or browsers. A closed tab and disabled storage may lose the original key; this is a known limitation, not permission to recreate the Staff record.
- **No negative receipt recovery:** a missing receipt never proves the original operation failed, and this design does not persist the original request body. If an owner wants automatic safe retry after reload, that requires a distinct approved durable server-side original-request/reconciliation contract and privacy/retention assessment.
- **No cross-entity completion:** Location and Service uncertain-creation parity is explicitly outside these PRs and remains open in #304.
- **Privacy and release gates:** review browser storage behavior against role switching, logout and same-device shared users; verify real controlled HTTPS, backup/restore, accessibility, legal retention and production security approval separately.

## Synthetic verification

- Backend #386: exact-current-main scoped receipt with verified role/tenant/actor/idempotency-key; PostgreSQL 16/17 and compiled browser.
- Mounted #387: a real Staff POST commits in PostgreSQL but its HTTP response is lost; first 404 does not resolve, second positive receipt resolves without a second POST.
- Reload #392: dedicated loopback PostgreSQL + compiled API/Chromium tests exercise *actual* COMMIT followed by lost response, tab marker surviving reload, **fresh signed Telegram reauthentication as the same legacy owner**, positive receipt and cleanup; separate PG tests cover same-tenant second actor namespace isolation, revoke and logout; web unit tests validate strict scope shapes and blocked storage.
- Code-tested exact head `ad0b50e1e9978d2a92800097066fd830b5b65a34`, [F1 CI #44727331500](https://github.com/tim8es/cookie/actions/runs/44727331500) **3/3 PASS**. Documentation commits following this head require their own exact-head CI before any merge decision.

## Acceptance needed

The owner/security reviewer must explicitly accept or change: HMAC-scoped marker design; secret rotation and multi-replica handling; retention/access after logout/revocation/regrant; sessionStorage usability on shared devices; absence-of-receipt unresolved UX; cross-tab/device expectations; and Location/Service parity boundaries. Until then all three PRs remain Draft and this decision remains **PROPOSED**.
