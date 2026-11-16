# F1 #150 — integrated Outbox worker review against current main

**Status:** DRAFT, synthetic-only F1 engineering, not merged or deployed.

This branch has one parent, `a3f498a222fe43d0484389e93e5097cd0a76e7ae` (main after the
Cookie session guard #173 merge). It copies exactly the reviewed Outbox
worker source, synthetic-only handler deadline configuration, and all
timeout/claim/renewal/row-lock regressions from the independent QA #167
head `18808b0e8f2297312b06cdf39d831e3904e75a04`.

It represents a *single integration candidate* for the following
previously stacked dependencies:

- #143 bounded handler timeout: prevents indefinite supervisor wait
  and abandons expired leases without ACK or failure.
- #148 independent RED stale claim-response reproduction: #155 renews
  the exact lease before attempting handler dispatch.
- #157 independent RED delayed renewal-response reproduction:
  #166 acquires an actual PostgreSQL transaction with current-token,
  unexpired `FOR UPDATE SKIP LOCKED` authority and calls the handler
  synchronously **while holding the row lock**, before COMMIT.
- #167 independent positive lock-proof: validates that the row is
  really locked when the handler begins, and that correct valid work
  still completes.
- `worker-dispatch-authority-lock.integration.test.ts`: full
  Pool.query + Pool.connect adapter, preventing a false green due to
  a test stub without transactional client support.

**Unchanged QA sources:** copied byte-for-byte from final #167
branch, not rewritten to pass on current main. The actual source blobs
are audited in the integration PR. The extra documentation here
records only the dependency collapse, not a new release contract.

## What must be verified together

Full GitHub F1 CI on the current integration head: static/type/unit,
real PostgreSQL 16, migration, backup/restore, worker/SIGTERM, API,
Svelte and browser smoke. No old parent CI establishes correctness
against the new main. Any new failure is FAIL until independently
explained and corrected; no unstated skips.

**Important limits:** the guarantee is *linearized synchronous
handler start*, not exactly-once asynchronous provider side-effects.
A cancelled handler that ignores abort and later sends externally can
still race with a replacement after lease expiry. Real provider
adapters require durable end-to-end deduplication with the stable
event key plus explicit authorizations (#19). No provider, production
deployment, real user/PII data, payments or commercial pilot is enabled.

Main protection #144, required reviews and final integration gates
remain open. Don't merge the earlier #143/#155/#166 parent PRs
independently after collapsing their changes here.
