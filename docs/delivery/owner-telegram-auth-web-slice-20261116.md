# F1 vertical slice 01 — verified owner sign-in through Telegram Mini App

**Status:** Draft engineering candidate, not pilot-ready. Stacked on PR #221 / #217 / #211 / #208; acceptance is blocked by independent review and exact-head CI. Related #203, #23, #66, #113, #165, #175.

## Delivered surface (web + API)

- In **API mode** only, the web UI loads the official Telegram WebApp SDK from `https://telegram.org/js/telegram-web-app.js` (with a bounded timeout). Mock mode does not request this external script; the operator must review the SDK/CSP supply-chain exposure before enabling real users.
- In **API mode** only, the web UI reads `window.Telegram.WebApp.initData` directly from Telegram Mini App. No proof input fields, query-string fallback, debug bypass, fake account selector or sessionStorage authentication.
- Signed initData is sent **once** to `POST /v1/auth/telegram/exchange`. Server cryptography, existing owner/link and DB role govern success; the browser does not mint a user, tenant or role.
- UI validates the short-lived bearer response and issues `GET /v1/organizations/:tenantId/session-context` with Authorization. It displays verified status only if both server operations succeed and their tenants match.
- Access tokens are held **only in JS memory**. No log, URL, localStorage, sessionStorage, automatic retry or cross-tab synchronization. A reload requires fresh Telegram initData; the previous one-time proof cannot be replayed.
- The logout action calls `POST /v1/auth/logout`, and local credential is discarded before the HTTP request. If server revocation fails, UI **does not claim a successful remote logout**.
- Protected session-context responses now use `Cache-Control: no-store`, `Pragma: no-cache` and `Vary: Authorization`, including denial and upstream failure cases.
- In default-disabled API AuthN, the UI remains locked; existing mock mode stays a **separate explicit local demo**. **No live CRUD/booking/calendar is exposed** by this slice.

## Validation and review

`pnpm --filter @cookie/web check` exercises web tests with a fake fetch: exchange 201, 401/404/503, invalid bearer/tenant/expiry, mismatched/denied context, best-effort revoke and logout error. `pnpm test` checks cache isolation of protected context. All other F1 gates, PG16/17 and browser visual smoke must run on the exact stacked tree.

Manual private-staging smoke with **synthetic, consented test owner only** after approval:

1. Provision an owner and link an HMAC-verified Telegram test account using the operator-only procedures in `docs/operations/telegram-owner-auth-staging.md`.
2. Compile API-mode web and opt in server AuthN with HTTPS, safe secrets and a private test network. Open the Mini App **through the bot**, never from a copied URL.
3. Confirm a verified-owner state appears only after the exchange and protected context. Reload: the consumed proof must not silently reauthenticate; reopen from Telegram for a fresh proof.
4. Use **Выйти**. Confirm 204 and that the bearer no longer opens the protected context. With a fault-injected 503/logout network failure, confirm UI warns that server revocation is unproven.
5. Outside Telegram or with invalid/replayed proof, UI stays locked and no bookings, mock records or workspace data are shown.

**Limitations:** The upstream #221 chain is still Draft; real Telegram provider configuration/host deployment is not approved. This is an AuthN/UI handshake, **not** completed owner registration, Service/Staff CRUD, Schedule publication, Booking API or a real business calendar. Full #203 acceptance, #113/#165 and #175 gates, legal/data-localization and operational review remain open.