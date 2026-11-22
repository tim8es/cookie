# F1 developer commands

Migration CLI lives in `packages/platform-db/src/cli.ts`. Run from the repository root using `pnpm db:migrate` after starting the **synthetic local development** PostgreSQL service.

Production deployments must not perform migrations automatically on API startup. No live customer data, secrets, payment providers or external messaging channels are used by this bootstrap.

## Synthetic backup/restore CI gate

`scripts/ci-restore-smoke.sh` is a **CI-only**, hard-guarded PostgreSQL 16 verification script. It refuses any environment except `CI=true` with the exact synthetic GitHub Actions `TEST_DATABASE_URL`. It uses ephemeral Docker PostgreSQL 16 client binaries to `pg_dump` the test database into a temporary private runner directory, `pg_restore` into a **separate** database, and assert the migration registry (3 migrations), tenant/outbox fixture and deduplication index survived. The temporary restore database and dump are deleted by shell trap. Nothing is uploaded.

This is evidence of basic schema/data logical restore in CI, **not** proof of encrypted/offsite automated production backups, recovery under load, retention policy, backup integrity under real incidents, target RPO/RTO or compliance with Russian personal-data requirements. Do not run against customer databases.


## Opt-in Linux Chromium/CDP startup stress probe (#164)

On a **disposable CI/developer Linux host with Chromium installed**, run from repository root:

```sh
node scripts/f1-chromium-stress.mjs --samples=10
```

Optional `COOKIE_BROWSER_BINARY=/absolute/path/to/chromium` chooses the browser executable. Samples are serial and capped at 20 (default 10). Each sample uses the production-shaped **test-only Chromium launcher flags**, Chromium-owned `--remote-debugging-port=0` and `DevToolsActivePort`, the same CDP `/json/list` page-target probe and the existing **two attempts × 12 seconds** pre-readiness retry. Every attempt uses its own temporary profile; all browser processes and profiles must be cleaned up before continuing.

The script prints `F1 CHROMIUM STRESS SAMPLE` JSON per sample and `F1 CHROMIUM STRESS SUMMARY` with total passes, failures and startup recoveries. **Any failed sample returns a nonzero exit code**, even if later samples pass. It makes no Booking/API/SQL requests, does not replay browser assertions, and is intentionally not in routine CI to avoid multiplying expensive/flake-prone Chromium starts. Its deterministic aggregator tests **are** in `pnpm test`.

Record the exact git SHA, runner image, Chromium version, sample JSON and affected F1 job when reporting a failure to [#164](https://github.com/tim8es/cookie/issues/164). A green sample batch is **not** proof the intermittent Linux startup root cause is fixed, nor a replacement for the mandatory PostgreSQL+real-browser gates.
