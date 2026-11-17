# Real owner browser acceptance (#23/#66/#203)

CI runs the built API-mode web bundle from the actual compiled Fastify main process with real PostgreSQL and ephemeral synthetic Telegram HMAC credentials. No fake HTTP routes, client-side session spoofing, mock data, real Telegram account, or real PII.

The browser exercises invalid proof refusal, successful server exchange/context check, creating and listing a Service draft, creating a StaffProfile with a Location + Service assignment, database rows and inactive status, logout/session revoke, API restart, a fresh signed launch and persisted identities/rows at 375, 320 and 1280 CSS pixels. It checks horizontal overflow, accessible names, browser storage and no external network requests. The PostgreSQL instance is strictly limited to the loopback disposable `cookie_ci` database. CI output never records raw signed data, bearer, bot token, or HMAC secret. This is a separate quality gate after existing synthetic browser evidence, not a replacement or a physical Telegram SDK/device/TLS test.

Run only in dedicated test environment: `CI=true TEST_DATABASE_URL=... pnpm build:runtime`, followed by `CI=true TEST_DATABASE_URL=... node apps/web/scripts/real-owner-browser-smoke.mjs`. The URL must target the disposable local cookie_ci database; CI provisions it automatically. No deployment or real customer data is authorized by this test.

Production, actual Telegram provider, Altare deployment, booking/calendar, and commercial pilot remain separate acceptance gates.
