# F1 Private staging: verified Telegram owner link and session exchange

**Status: engineering candidate, review required.** The standard API still
starts without a login route; synthetic data only. This does not authorize
real Telegram users, actual salon/customer PII, a commercial pilot, public
bookings, payments or live Telegram provider credentials without #37/#38 and
explicit owner approval.

## Exact trust chain

1. A DB-privileged operator creates an Identity/Organization/Location/Owner role
   with the #217 `start:provision-owner` command.
2. Only the owner who controls the relevant Telegram Mini App account supplies
   raw signed `Telegram.WebApp.initData` through a **private operator channel**.
   The operator records explicit consent, verifies the owner's entitlement to
   the tenant and runs `start:link-telegram-owner`. The CLI validates the
   HMAC and auth_date using the exact bot token, does not trust username or
   tenant from Telegram data and stores only an independent HMAC fingerprint,
   proof timestamp and consent timestamp in the existing trusted-links table.
   A conflicting active Telegram user or already-linked owner is rejected.
3. Private staging can opt in to the one-time `POST /v1/auth/telegram/exchange`
   API. The request body is **only** `{"initData":"raw query string"}`;
   no `tenantId` or `identityId` accepted. The responder returns a random
   short-lived Cookie bearer plus server-resolved tenant. Raw bearer is not
   stored in PostgreSQL, which retains only SHA-256. One Telegram proof hash
   can be consumed only once. Replays and revoked links/sessions deny access.
4. `GET /v1/organizations/:tenantId/session-context` performs
   server-authoritative session validation + transaction-scoped policy check,
   including current membership/role and revocation serialization.
   The returned identity may only see its tenant; **no Booking routes are
   enabled** in production bootstrap.

## Configuration (code candidate, no live rollout)

Server-only runtime environment:

- `COOKIE_TELEGRAM_AUTH_MODE=enabled` — explicit opt-in, otherwise no route.
- `COOKIE_PUBLIC_ORIGIN=https://your-private-stage.example` — validated HTTPS
  public origin behind a trusted TLS termination proxy. Protect upstream ports;
  do not send bearer tokens over plaintext network.
- `COOKIE_TELEGRAM_BOT_TOKEN` — exact bot secret, **not** in Git, logs or web.
- `COOKIE_TELEGRAM_USER_HMAC_SECRET` — stable **independent** 32-byte hex
  secret; rotating it invalidates the link lookup until a reviewed migration.
- `DATABASE_URL` — private PostgreSQL connection URL with least privileges.

Operator link command requires the additional
`COOKIE_OPERATOR_LINK_TELEGRAM=acknowledged`,
`COOKIE_TELEGRAM_LINK_CONSENT=confirmed`,
`COOKIE_OWNER_TENANT_ID`, `COOKIE_OWNER_IDENTITY_ID` and signed raw initData
on **stdin**. These values must never be accepted from untrusted HTTP clients.
The command prints only link ID and replay status.

Only the exact HMAC-verified owner can exchange a signed proof for a Cookie
bearer; a session expires in 900 seconds and the initial proof must be no older
than 300 seconds. Store the returned bearer in memory, not localStorage or URL.
The bearer-only `POST /v1/auth/logout` route revokes its exact Cookie session and returns 204 without exposing tenant metadata. A new Telegram session needs a fresh launch proof; reusing previous initData
intentionally fails as replay. User self-service linking, phone OTP, multi-
tenant picker, secure delivery UX/cookie/CSRF, distributed rate limits,
alerting and consent/deletion runbooks remain unfinished.

## Evidence

`apps/api/test/telegram-owner-auth.integration.test.ts` runs with real
PostgreSQL and synthetic cryptographically signed Mini App data, covering
owner provisioning, operator consent, cross-tenant link conflict, public
route default deny, bearer issuance, replay denial, session context,
foreign tenant 403 and revoke denial. Exact PR head CI and independent
security review are required before considering an opt-in staging activation.

Telegram bot-owner HMAC spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
