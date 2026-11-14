# F1 developer commands

Migration CLI lives in `packages/platform-db/src/cli.ts`. Run from the repository root using `pnpm db:migrate` after starting the **synthetic local development** PostgreSQL service.

Production deployments must not perform migrations automatically on API startup. No live customer data, secrets, payment providers or external messaging channels are used by this bootstrap.
