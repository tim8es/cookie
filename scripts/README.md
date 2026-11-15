# F1 developer commands

Migration CLI lives in `packages/platform-db/src/cli.ts`. Run from the repository root using `pnpm db:migrate` after starting the **synthetic local development** PostgreSQL service.

Production deployments must not perform migrations automatically on API startup. No live customer data, secrets, payment providers or external messaging channels are used by this bootstrap.

## Synthetic backup/restore CI gate

`scripts/ci-restore-smoke.sh` is a **CI-only**, hard-guarded PostgreSQL 16 verification script. It refuses any environment except `CI=true` with the exact synthetic GitHub Actions `TEST_DATABASE_URL`. It uses ephemeral Docker PostgreSQL 16 client binaries to `pg_dump` the test database into a temporary private runner directory, `pg_restore` into a **separate** database, and assert the migration registry (3 migrations), tenant/outbox fixture and deduplication index survived. The temporary restore database and dump are deleted by shell trap. Nothing is uploaded.

This is evidence of basic schema/data logical restore in CI, **not** proof of encrypted/offsite automated production backups, recovery under load, retention policy, backup integrity under real incidents, target RPO/RTO or compliance with Russian personal-data requirements. Do not run against customer databases.
