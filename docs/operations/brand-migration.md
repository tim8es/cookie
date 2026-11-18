# kuki — rebrand and compatibility inventory

**ACCEPTED product spelling:** `kuki` (lowercase), owner decision 2026-11-17, [#305](https://github.com/tim8es/cookie/issues/305). Former working name: Cookie / Kuki. Historical records and original evidence retain their original wording. Branding is distinct from tenant-provided names and the HTTP cookie protocol.

## Phase A — display branding

Use kuki for platform wordmarks, titles, metadata, accessible labels, public booking attribution, onboarding, owner screens, Telegram surfaces and future copy. Do not modify persisted tenant names. Preserve functionality, style and existing security gates. Review concurrent F1 PRs for reintroduced old display strings before merge. Separate changes to actual integration settings from this slice.

## Phase B — retained technical identifiers

| Area | Examples | Rationale / migration plan |
| --- | --- | --- |
| Packages and workspace | `@cookie/*`, lockfile, package filters | Atomic workspace rename with dependency graph, lockfile regeneration and full CI; coordinate all active PRs. |
| PostgreSQL and migrations | `cookie_identity`, `cookie_tenancy`, `cookie_booking`, other `cookie_*` schemas | Do not rewrite applied migrations. Inventory all schema/role references; design forward migrations, backup/restore and same-major upgrade/rollback evidence before changing. |
| Auth and protocol | HTTP `Cookie`, `Set-Cookie`, bearer format and verifier identifiers | Standard HTTP terms never change; any product-specific credential format change requires separate compatibility/security review, exact token/session revocation tests, no forced silent identity changes. |
| Browser storage and test selectors | `cookie.frontend-demo.v1`, `cookie.staging.pending.*`, `data-cookie-mode` | Keep existing keys to preserve pending idempotency receipts and demo state; migrate versioned keys only with compatibility tests, including uncertain booking retry. |
| Config, scripts and CI | `COOKIE_*`, Compose names, DB users, CI artifacts, nginx variables, local launcher | Audit staging/CI and consumers; provide compatible aliases or explicit coordinated cutover, validate secrets/environment and local/private staging health, CI and restore. |
| Frontend tokens/internal identifiers | `--cookie-*`, `CookieUiPort`, `MockCookieApi` | Internal implementation only; optional atomic refactor with structure check and browser smoke. |
| GitHub and links | `tim8es/cookie`, existing issue/PR URLs, remotes | Keep current canonical URL until coordinated. Audit branch protection, runners, webhooks, deploy callbacks, and remote URLs; verify redirects and update integration consumers after an explicitly coordinated rename. |
| Linear, automations, integrations | Existing project identifiers, repo references, task names, provider credentials | Inventory outside repo; coordinate owner/agent migration and verify routing, task triggers and permissions end to end. No external name changes claimed here. |

This inventory is a starting point, not an exhaustive repository/remote scan. Before Phase B, record exact references, owners, affected environments, proposed compatibility/rollback plan and test results. Re-run code search against the final merged main, including active branches and non-text assets; inspect Telegram notification templates and third-party integrations. Do not change production or real customer data. Keep #305 open until all acceptance criteria have actual evidence.
