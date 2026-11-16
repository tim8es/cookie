# F1 Security integration review — exact-base merge gate (2026-11-16)

**Status: REVIEW / NOT RELEASE-APPROVED.** Evidence snapshot: `main` **`59225edc69e190a9e189322e01f1eab0dfac64f5`** after merged compiled-worker proof [#194](https://github.com/tim8es/cookie/pull/194). This report inventories independently verified code/QA and remaining integration gaps. **It changes no runtime code, DB schema, tests, CI or release settings.** Approval of F1 engineering does **not** authorize a real Telegram/PII/payment provider, production rollout or commercial pilot.

## 1. Already integrated — do not merge an old copy

| Source | Actual main state | Scope and limit |
| --- | --- | --- |
| [#173](https://github.com/tim8es/cookie/pull/173), [#180](https://github.com/tim8es/cookie/pull/180) | MERGED | Canonical exact Cookie bearer/session/link Booking guard + independent revoke-first, expiry, membership race, positive Booking/idempotency QA |
| [#187](https://github.com/tim8es/cookie/pull/187) | MERGED | Multi-role cross-tenant and role permission revocation QA |
| [#188](https://github.com/tim8es/cookie/pull/188) | MERGED | Real PostgreSQL bearer revoke/expiry after HTTP preflight for Cancel/Reschedule; prior exact-head green F1 CI [#43926269879](https://github.com/tim8es/cookie/actions/runs/43926269879) |
| [#190](https://github.com/tim8es/cookie/pull/190) | MERGED | Revoke-before Workspace read: exact bearer, expiry and Telegram unlink; old stacked #183 was closed without merging |
| [#189](https://github.com/tim8es/cookie/pull/189) | MERGED | Bounded opaque-session cleanup integration; full retention policy/scheduler remain [#153](https://github.com/tim8es/cookie/issues/153) |
| [#194](https://github.com/tim8es/cookie/pull/194) | MERGED | Compiled synthetic worker claims/ACKs a real PostgreSQL Outbox event; [#191](https://github.com/tim8es/cookie/issues/191) closed |

These are **F1 synthetic engineering proofs**, not public production AuthN, operational delivery guarantees or real-customer acceptance. Existing open P0 issues remain independently release-blocking.

## 2. BLOCKER: strict Workspace policy candidate #179 must be re-based without coverage loss

[Draft PR #179](https://github.com/tim8es/cookie/pull/179) current reviewed HEAD `cd689f6e80686de1a75489a75e804b83bdcde41b` (reviewed against `main` `3833803c554c4e4cd5593e215ed7bb12c494ea77`) advertises **15 changed paths** because it was built on an older session/identity stack before being retargeted to main. **Most old source and test blobs are identical to main**, so it is inaccurate to treat every listed path as a new runtime change.

The actual distinct runtime policy proposal is:
- `packages/platform-identity/src/postgres.ts`: export existing canonical `lockPolicyRows` helper (main file already contains the implementation).
- `apps/api/src/workspace-http.ts`: call that helper **before** `assertActiveOpaqueSession` at the start of the same protected Workspace read transaction, preserving Organization → Membership → Assignments → Roles → Telegram Link → Cookie Session order.
- Add independent previously RED strict-role QA `apps/api/test/workspace-role-revoke-read-qa.integration.test.ts` with original blob `342302318473e08746676cd9c475c1944856d7e1`; add focused rationale docs.

**Concrete coverage regression in retargeted #179:** `apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts` in current main has blob **`94d9b3999d36f36da6554b7d1a809f0cc47c1f1f`**, **336 lines / three modes** (bearer revoked, **expired**, Telegram unlink). #179 HEAD instead has the older blob **`e4ac865f55cd536af38067a175788dfe8b0fcda7`**, **306 lines / two modes**, omitting expiry and its negative side-effect checks. This is a **test-coverage downgrade if merged without reconciliation**, not proof of a new backend exploit. A blocking review comment is posted to #179.

**Required correction:** reconstruct the strict candidate on **the current exact main** without replacing the merged three-mode #165 test; include only the two actual source changes, the original strict-role QA and relevant review docs. Verify diff, blob provenance, and exact merged-tree full F1 CI. Do **not** merge both obsolete combined Draft #182 and #179, and do not resurrect old #171 or #183 branches.

**Owner/security decision [#175](https://github.com/tim8es/cookie/issues/175) remains OPEN.** Strict transaction-scoped read serialization and documented MVCC snapshot/read-first are both viable policy choices; green tests on a candidate do not silently accept the stronger option. Explicitly record the semantics for Membership, RoleAssignment, Role and per-Location scope changes before implementation merge. Cover frontend capability/client-metadata invalidation on 403 and Organization/Location switches as a separate acceptance requirement [#66](https://github.com/tim8es/cookie/issues/66). The Workspace route exercised here is opt-in/synthetic, **not** mounted in the public production bootstrap.

## 3. Read-first Cookie guard #193 — green with a documented Chromium flake

[Draft QA PR #193](https://github.com/tim8es/cookie/pull/193), test-only head `89d9d58e481c588c32fed82fd34e4cefba449ab5`, base `main` `3833803c554c4e4cd5593e215ed7bb12c494ea77`. In its earlier failed F1 [run #43930722164](https://github.com/tim8es/cookie/actions/runs/43930722164), the specific protected-Workspace PostgreSQL lock regression **passed**, but another test failed with `Chrome DevToolsActivePort timed out`. Failure was **65/66** PG integrations, not an AuthN assertion failure. A retry of the **same failed job on the same PR head** passed completely: **103/103 unit, 66/66 real PG16 integration, 46/46 web**; the two-mode Workspace Cookie/Telegram revocation read-first test also passed unchanged (~998 ms). Logged in [#164](https://github.com/tim8es/cookie/issues/164).

The retry is an exact-HEAD green result **for the tested base**; it does not eliminate intermittency or automatically validate `main` updates after `3833803...`. The latest main now includes the independently merged #194 compiled-worker smoke. Before merging #193, verify a **single combined current-main tree** and rerun *all* steps without deleting/skipping browser integration. This QA tests specific session/link transaction ordering; it does not resolve strict role-read #175.

## 4. Explicit merge and security acceptance

| Gate | Required observable evidence | Status |
| --- | --- | --- |
| No security-regression coverage loss | Confirm three-mode bearer/expiry/unlink test retained byte-for-byte in final merge tree; review exact file delta for #179 | **BLOCKED** for old #179 branch |
| Owner selects Workspace role snapshot contract | Accepted choice recorded in issue #175, including concurrency order + forbidden-cache behavior | **OPEN** |
| Main+candidate combined CI | On **the final integrated head**, lint, Prettier, boundaries, typecheck, unit, real PG16 migration/integration and isolation/race, restore, compiled worker, Svelte/web, Chromium HTTP and browser evidence | **PENDING**; old green runs are not equivalent |
| Role/Booking security review | Reconcile [#113](https://github.com/tim8es/cookie/issues/113) P0 and [#165](https://github.com/tim8es/cookie/issues/165) P0 acceptance with the merged guards, independent reviewer and race matrix; do not mark PASS only from mock/synthetic production claims | **OPEN** |
| Mandatory protected `main` quality gates | Verify that PR review and exact commit required checks are **enforced by repository settings**. Issue [#144](https://github.com/tim8es/cookie/issues/144) documents previous `protected:false` and inaccessible ruleset endpoint. An Actions workflow alone **cannot enforce PR-only merges**. | **OPEN / current account settings not reverified** |
| CI launch reliability | [#164](https://github.com/tim8es/cookie/issues/164) intermittent Chromium CDP/DevToolsActivePort; isolate launcher lifecycle/health check, do not broadly retry/skip security assertions | **OPEN** |
| F1 real delivery / legal gates | Real providers, customer PII, payment flows, commercial pilot, production deployment, full retention and consent policy | **NOT AUTHORIZED** |

**Order:** (1) preserve merged main and block #179's stale QA replacement; (2) obtain #175 decision; (3) clean strict candidate only if accepted (otherwise document/test snapshot contract); (4) compose with #193 and other already-merged proofs on a frozen current main; (5) get independent security review + fully green exact-merge CI and protected-main settings; (6) then consider closure of #113/#165. No production/pilot inference at any stage.

## Evidence discipline

All technical claims are tied to GitHub PR HEADs, file blob SHA comparisons and recorded F1 Actions runs; **run results do not automatically carry forward** across base changes. PostgreSQL serialization tests use synthetic actors and two actual database connections, not real customer identities. The source of truth for F1 acceptance remains [test strategy](test-strategy.md), [F1 negative cases](f1-pilot-acceptance-cases.md), [#175](https://github.com/tim8es/cookie/issues/175) and the accepted F0/F1 boundaries in `AGENTS.md`. The exact report base is noted above; reevaluate if main advances.
