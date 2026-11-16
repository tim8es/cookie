# F1 CI evidence and future release gates

**Status: F1 engineering only.** This document is NOT approval to deploy to production, use real personal data, collect payments, or run a commercial pilot. No deployment job, production secret, staging environment, or customer data is created by this change. Follow [pilot-operational-readiness](pilot-operational-readiness.md) for additional proposed gates.

## Confirmed CI baseline — 2026-11-16

- Only one existing workflow: `.github/workflows/f1-ci.yml`, named **F1 quality gates**. Do not add a duplicate workflow.
- Existing PR run [43889327565](https://github.com/tim8es/cookie/actions/runs/43889327565) completed successfully on head `0aab2547b88912e92944d71fb972516a58ea9a8c`; run wall clock 14:46:45–14:48:42 UTC, **117 seconds**. This is one observed sample, not a percentile or proof of speed improvement.
- Failed run [43888745415](https://github.com/tim8es/cookie/actions/runs/43888745415) failed at a **compiled synthetic worker** smoke, while later steps were skipped. This was a product/worker-runtime change on another agent's PR #138 and was corrected by that agent in a subsequent successful run. Our CI patch does not change this test.
- Last inspected workflow ran lint, Prettier, kernel/API/UI boundary checks, API TypeScript, API/shared unit tests, PostgreSQL 16 integration/migration tests, synthetic backup/restore, API build, synthetic worker SIGTERM, Svelte check **including web unit tests**, web build and Chromium browser demo smoke.
- CI runs a **single sequential job**; PostgreSQL integration takes approximately 30 seconds within a 117-second example, while the cold `pnpm install` downloaded 254 packages. Split jobs have not been justified by measured end-to-end cost.
- Before this patch: no pnpm store cache, no cancellation of superseded PR runs, no push verification of `main`, and missing visual artifacts silently ignored.
- At audit time `main` reported **protected: false**; the API returned 403 for protection settings, and the rulesets endpoint was unavailable for this private repository's plan. **No required-check enforcement** was proven. Track this independently in [Issue #144](https://github.com/tim8es/cookie/issues/144); protecting `main` needs administrator/plan-level action and cannot be simulated by a passing CI check.

## Changes in the infrastructure-only PR

1. Run the same gate for all PRs, plus post-merge pushes to `main`; remove the obsolete bootstrap branch push trigger. No `pull_request_target` and no workflows with write tokens.
2. Cancel outdated runs of the **same PR** on new commits, but do not cancel `main` runs. Treat a passing run only as evidence for the specific PR **head SHA** shown in the summary, as tested using GitHub's PR merge ref.
3. Pin third-party GitHub Actions to verified immutable commit SHAs: checkout, pnpm setup, Node setup and artifact upload; disable persisted checkout credentials in untrusted PR test environments; manually review future upgrades.
4. Cache **pnpm's package store**, keyed through `pnpm-lock.yaml` by setup-node; continue `pnpm install --frozen-lockfile`. Do not cache `node_modules` or share PostgreSQL state.
5. If a browser smoke actually ran, missing visual evidence must fail the upload step. After a successful browser smoke, run `node scripts/ci-visual-evidence-check.mjs`: fail on missing/corrupt/extra PNG files, incorrect viewport widths, incomplete manifest, non-synthetic sessions, connected backend or external requests. Preserve evidence after a browser-smoke failure when produced. Append tested/source SHAs and smoke outcome to the run's job summary.
6. Keep one workflow/job and all existing mandatory test commands; no skip/path filter or CI bypass introduced.

### Required F1 gate / evidence boundary

| Verification | Current command / artifact | Interpretation |
|---|---|---|
| Lint, formatting, boundaries | `pnpm lint`, `pnpm format:check`, `pnpm check:boundaries`, `pnpm check:ui` | Code style and architecture boundaries |
| API types and unit tests | `pnpm typecheck`, `pnpm test` | Static and in-memory tests |
| Real DB | `pnpm test:integration` against disposable PostgreSQL 16 | Migration/transaction behavior covered by present tests; not universal proof |
| Backup/restore | `scripts/ci-restore-smoke.sh` with **exact** `cookie_ci` URL | Local synthetic restore only; no remote backup retention or RPO/RTO |
| API and worker | `pnpm build` + current worker smoke | Build/startup only; PR #138 independently proposes a compiled worker smoke |
| Web types/unit/build | `pnpm --filter @cookie/web check`, then `pnpm --filter @cookie/web build` | `check` already includes web unit tests |
| Chromium visual regression | `node apps/web/scripts/browser-smoke.mjs`, `node scripts/ci-visual-evidence-check.mjs`, visual artifact | 39 required PNGs (13 scenes × 3 viewports), synthetic manifest; **does not** establish all real backend Booking E2E paths |
| PR merge eligibility | Passing checks for latest head and reviewed diff | **Organizational rule only** until GitHub branch protection enforces it |

**No PASS by omission:** a skipped mandatory step is not equivalent to passing the complete gate. Do not merge PRs based solely on stale or rerun statuses from earlier commits. The workflow's all-in-one job is deliberately preserved while repository-level required checks are unavailable.

### Runbook: reproduce and investigate

On Node 26 with pnpm 10.24.0:

```sh
npm install --global pnpm@10.24.0
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm check:boundaries
pnpm check:ui
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @cookie/web check
pnpm --filter @cookie/web build
node apps/web/scripts/browser-smoke.mjs
node scripts/ci-visual-evidence-check.mjs
```

Browser smoke requires installed Chrome/Chromium; screenshots and manifest are **synthetic**. For PostgreSQL integration, start local development PostgreSQL with `docker compose -f docker-compose.dev.yml up -d` and use the separately documented local development DB URL. The **CI-only restore smoke refuses to run** without `CI=true` and the exact isolated `cookie_ci` database URL; never bypass that guard for real data.

To debug a PR: open **Actions → F1 quality gates**, select the run associated with the PR's **latest head**, inspect failing step, commit SHA and generated summary; download the `cookie-frontend-visual-smoke` artifact if browser smoke ran. PostgreSQL logs include deliberately induced synthetic constraint errors and are not by themselves proof of a failed test. Prefer the failing step's exit status. If a run is canceled by a newer commit, inspect the replacement run instead.

## Future gates — DOCUMENTED ONLY, not implemented deployment

| Gate | Proposed requirements | Current state |
|---|---|---|
| G0: PR quality | Exact current SHA, green mandatory checks, review of security/Booking/DB changes, synthetic artifact | Partly automated; branch protection missing |
| G1: isolated staging rehearsal | Explicitly approved disposable environment; synthetic-only DB, migrations from known version, schema compatibility, actual Browser → API → PostgreSQL smoke, outbox/worker, monitored backup and **timed restore** | **Not deployed**, future work |
| G2: pre-release security/data | Tenant isolation + IDOR/authZ races incl. #113; secrets isolation, deployment provenance/SBOM, dependency scan, manual threat review; prove no real data in artifacts | **Not complete** |
| G3: release approval | Named owner approval; signed/versioned artifact and manifest; documented upgrade path and post-deploy health rollback decision; legal/payment/PII gates separately accepted | **Not authorized** |
| G4: production/pilot | Only with separately explicit authorization and verified compliance, monitors, backups, health and commercial gates | **Forbidden at current F1 stage** |

### Release/rollback/DB operating contract (future)

- **Before migrations:** verify backup + restore into isolated DB, schema version, locking/DDL risk, compatibility with prior application version, safe lock timeouts, and realistic rollback plan. Record migration identifiers and checksums; never silently rewrite applied migrations.
- **During potential deployment:** one authorized release at a time, migrate under controlled permissions, gate readiness/liveness and DB connectivity, booking transaction smoke and outbox lag; maintain an audit trail of commit, artifact digest and migrator identity.
- **On failure:** stop further unsafe writes, keep durable Booking/outbox records, roll back application only where schema is backward-compatible; otherwise use reviewed forward-fix or isolated restore. Do **not** automatically run unreviewed down-migrations or restore over live data.
- **Afterwards:** verify tenant-scoped bookings, idempotency, constraints, outbox dedupe and retries; monitor errors, queue age and database health, publish a release incident record if needed.
- **Production prerequisites remain open:** exact platform/region, secrets, image provenance, network exposure, TLS, PII retention/legal, backup off-host and restore cadence, RPO/RTO, alerting, owner approval and cost profile.

## Synchronization / proof of current base

The CI PR is synchronized with `main` commit `0c5cffa148c88d169689abe82eedf6abe8cd3e78` (Telegram HMAC PR #141), without altering product files. PR #138 still proposes a different compiled-worker smoke in the same workflow; reconcile its gate by retaining the stricter compiled verification and rerunning exact-head CI after both changes meet. Do not silently discard either smoke test.

## Measured performance / open risks

Baseline run [43889327565](https://github.com/tim8es/cookie/actions/runs/43889327565): **117 seconds**. First post-change run [43890432409](https://github.com/tim8es/cookie/actions/runs/43890432409): **128 seconds**, successful, full visual evidence present; the initial cache was populated (254 packages downloaded; store cache saved under the lockfile key). Next warm run [43890995415](https://github.com/tim8es/cookie/actions/runs/43890995415) on head `aca4ed20` succeeded in **119 seconds** with cache hit (254 reused, 0 downloaded) and visual artifact. The observed cold→warm improvement was 9 seconds (~7%) but still **2 seconds slower** than the unrelated 117-second pre-change run. Both runs preceded the stricter 39-PNG verifier and latest-main synchronization; measure new exact-head CI again.

Known risks: unprotected `main`, no enforced mandatory status contexts, action SHAs need periodic review, mutable PostgreSQL 16 Alpine image, no dedicated supply-chain/license vulnerability gate, test coverage is bounded by implemented F1 functionality, and visual screenshots may contain synthetic-only test data but still require review before public sharing. This pipeline does not prove production readiness.

## Final combined main-based verification (2026-11-16)

This CI PR now includes compiled-worker fail-closed smoke from #138 via merged child #186, and PNG viewport/full-page height verification from #181. It is explicitly targeted to current `main` `f9df29a2f7c5865da6814c6f6a0423fe47b85569`, which already has the F1 Cookie security guard (#173), bounded normal/alert maintenance (#159/#161) and the final Outbox handler-start worker (#166). The existing workflow remains a **single** job with source-commit evidence, pinning, pnpm caching, read-only formatting, real PostgreSQL16, restore, compiled worker startup/shutdown, Svelte checks and Chromium visual artifact verification. No new deployment job, secrets or production permission.

Before merging, require a **new exact-head full F1 GitHub CI PASS on the combined PR merge ref**. Earlier PASS for child #186 or parent #139 on old bases cannot substitute for latest main. Enforced GitHub branch protection/required statuses are still blocked by #144 (administrator/plan action), not silently implemented by this workflow.
