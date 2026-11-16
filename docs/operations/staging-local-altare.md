# Real staging runtime: local and Altare (not a production pilot)

Status: staging packaging candidate for #203/#36, **not end-to-end Cookie**. Current main still has no real AuthN, owner onboarding, public Booking or production-safe notification dispatch. The API exposes health only; the staged frontend is built in **API mode**, with intentional disconnected state (not mock success). Never process actual salon/customer PII here without separately passing #37/#38 and legal review.

## Local or full Altare Workstation with Docker

Prerequisites: Docker Engine and Compose v2, available memory/disk, git checkout. Altare **Sandboxes do not provide Docker**; choose a full Workstation/VM for this Compose path. No Docker socket access or privileged container needed for Cookie.

1. Copy `.env.staging.example` to `.env.staging.local`; replace `COOKIE_DB_PASSWORD` with the output of `openssl rand -hex 32`. Use only URL-safe hex; never commit the file.
2. `docker compose --env-file .env.staging.local -f docker-compose.staging.yml up --build -d`
3. Browse `http://127.0.0.1:8080/`; the disconnected web status is **expected and correct** until #66 is implemented. Check `http://127.0.0.1:8080/health/ready` for a real DB readiness response. API routes beyond health must remain 404 until real identity and authorization exist.
4. `docker compose --env-file .env.staging.local -f docker-compose.staging.yml ps` and `... logs -f api` for diagnostics.
5. `docker compose --env-file .env.staging.local -f docker-compose.staging.yml down` stops services but **retains** the persistent Postgres volume. Do **not** use `down -v` on valuable data.

The API and migration runner use the same compiled Node.js 26 image; migrations are an explicit one-time dependent job before the API starts. Web assets are built with `VITE_COOKIE_DATA_MODE=api` and reverse-proxied to the API on the same origin. PostgreSQL 16 is private to the Compose network; only Nginx is exposed on the host **loopback**. On remote Altare Workstation use an SSH tunnel (e.g. `ssh -L 8080:127.0.0.1:8080 <workstation>`) or configure a separately reviewed TLS reverse proxy; do not bind publicly over plaintext HTTP.

The current worker entrypoint is **synthetic-only** by design and is deliberately not deployed here. Before full readiness, implement a real, policy-reviewed Outbox worker and notification adapter instead of reusing the synthetic no-op worker.

## Altare App Hosting / Docker Apps alternative

Altare's App Hosting supports GitHub-based Node.js 26 apps and HTTPS addresses. For a single HTTPS app, run `npm install --global corepack@0.36.0 && corepack enable && pnpm install --frozen-lockfile` (install), `pnpm build:runtime` (build), `pnpm start:api` (start) on Node.js 26, with `HOST=0.0.0.0`, platform `PORT`, `COOKIE_WEB_DIST=apps/web/dist` and separately provisioned `DATABASE_URL`. This serves compiled static web and API on **one origin**, without separate cross-origin browser configuration. Migration command is `pnpm db:migrate`, **not** on every API restart; run this as a controlled one-time command job. The server fails to start when `COOKIE_WEB_DIST` is set but `index.html` is missing. This is **not yet a verified one-click Altare deployment or a real Booking app**; #66/#113/#165 are still required.

Altare's managed Postgres currently uses **v17**; Cookie's tested baseline is v16. Validate migrations, concurrency/revocation, restore and driver behavior on PG17 before attaching live app data. Altare Docker Apps run **one image per app** and do not implicitly substitute for Compose orchestration or multi-service dependencies.

Do not turn on auto-deploy to real customers. Altare's supported regions and the legal requirements for Russian personal data have not yet been cleared. Do not claim that HTTPS alone grants compliance or data durability.

## Automated evidence

`scripts/ci-staging-compose-smoke.sh` is a **CI-only** disposable test. It builds compiled images, starts genuine PostgreSQL, applies checked migrations, verifies `/health/ready` through the web reverse proxy, asserts unapproved Booking URLs remain 404, creates a database sentinel, restarts API/Postgres, and proves the value survived. No mock owner/customer booking or real Telegram delivery is asserted. Next test must prove the full owner+customer live flow through API with real AuthN, PostgreSQL and browser — Issue #203, dependencies #66/#113/#165.
