# F1 Security integration review — exact-base merge gate (2026-11-16)

**Status: REVIEW / NOT RELEASE-APPROVED.** Initial review snapshot: `main` **`59225edc69e190a9e189322e01f1eab0dfac64f5`** after compiled-worker proof [#194](https://github.com/tim8es/cookie/pull/194). **Main advanced during review to `476eb9a3ed80024b203898e35aab6f6a1cfb7520` via merged QA #193**; all per-PR checks below identify their own source and base. This report inventories independently verified code/QA and remaining integration gaps. **It changes no runtime code, DB schema, tests, CI or release settings.** Approval of F1 engineering does **not** authorize a real Telegram/PII/payment provider, production rollout or commercial pilot.

## 1. Already integrated — do not merge an old copy

| Source | Actual main state | Scope and limit |
| --- | --- | --- |
| [#173](https://github.com/tim8es/cookie/pull/173), [#180](https://github.com/tim8es/cookie/pull/180) | MERGED | Canonical exact Cookie bearer/session/link Booking guard + independent revoke-first, expiry, membership race, positive Booking/idempotency QA |
| [#187](https://github.com/tim8es/cookie/pull/187) | MERGED | Multi-role cross-tenant and role permission revocation QA |
| [#188](https://github.com/tim8es/cookie/pull/188) | MERGED | Real PostgreSQL bearer revoke/expiry after HTTP preflight for Cancel/Reschedule; prior exact-head green F1 CI [#43926269879](https://github.com/tim8es/cookie/actions/runs/43926269879) |
| [#190](https://github.com/tim8es/cookie/pull/190) | MERGED | Revoke-before Workspace read: exact bearer, expiry and Telegram unlink; old stacked #183 was closed without merging |
| [#189](https://github.com/tim8es/cookie/pull/189) | MERGED | Bounded opaque-session cleanup integration; full retention policy/scheduler remain [#153](https://github.com/tim8es/cookie/issues/153) |
| [#194](https://github.com/tim8es/cookie/pull/194) | MERGED | Compiled synthetic worker claims/ACKs a real PostgreSQL Outbox event; [#191](https://github.com/tim8es/cookie/issues/191) closed |
| [#193](https://github.com/tim8es/cookie/pull/193) | MERGED, merge SHA `476eb9a3ed80024b203898e35aab6f6a1cfb7520` | Read-first Workspace bearer/Telegram-link transaction-lock QA; PR head `083cf9bb08f4193ee194ed1dbeefa44fd42792cd`, [full CI #43932193009](https://github.com/tim8es/cookie/actions/runs/43932193009) SUCCESS: 103/103 unit, 66/66 PG16, 46/46 web |

These are **F1 synthetic engineering proofs**, not public production AuthN, operational delivery guarantees or real-customer acceptance. Existing open P0 issues remain independently release-blocking.

## 2. Historical #179 coverage BLOCKER resolved by clean Draft #200; policy still undecided

[Draft PR #179](https://github.com/tim8es/cookie/pull/179) current reviewed HEAD `cd689f6e80686de1a75489a75e804b83bdcde41b` (reviewed against `main` `3833803c554c4e4cd5593e215ed7bb12c494ea77`) advertises **15 changed paths** because it was built on an older session/identity stack before being retargeted to main. **Most old source and test blobs are identical to main**, so it is inaccurate to treat every listed path as a new runtime change.

The actual distinct runtime policy proposal is:
- `packages/platform-identity/src/postgres.ts`: export existing canonical `lockPolicyRows` helper (main file already contains the implementation).
- `apps/api/src/workspace-http.ts`: call that helper **before** `assertActiveOpaqueSession` at the start of the same protected Workspace read transaction, preserving Organization → Membership → Assignments → Roles → Telegram Link → Cookie Session order.
- Add independent previously RED strict-role QA `apps/api/test/workspace-role-revoke-read-qa.integration.test.ts` with original blob `342302318473e08746676cd9c475c1944856d7e1`; add focused rationale docs.

**Concrete coverage regression in retargeted #179:** `apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts` in current main has blob **`94d9b3999d36f36da6554b7d1a809f0cc47c1f1f`**, **336 lines / three modes** (bearer revoked, **expired**, Telegram unlink). #179 HEAD instead has the older blob **`e4ac865f55cd536af38067a175788dfe8b0fcda7`**, **306 lines / two modes**, omitting expiry and its negative side-effect checks. This is a **test-coverage downgrade if merged without reconciliation**, not proof of a new backend exploit. A blocking review comment is posted to #179.

**Resolution after review:** the old #179 was **closed without merging**. Replacement [Draft #200](https://github.com/tim8es/cookie/pull/200), reviewed HEAD `5476459b610f190c9c17cc1f80890f8125fc420c`, base `main` `59225edc69e190a9e189322e01f1eab0dfac64f5`, has **exactly five files**: the two source changes, the original strict-role regression (verified exact blob `342302318473e08746676cd9c475c1944856d7e1`), and two QA/decision documents. It does **not** replace `apps/api/test/opaque-session-booking-revocation-qa.integration.test.ts`, so the three-mode main coverage is preserved in its reviewed PR delta. [Full F1 CI #43932202389](https://github.com/tim8es/cookie/actions/runs/43932202389) **SUCCESS**: 103/103 unit, **66/66 real PG16 integration**, 46/46 web, including original unchanged strict-role regression PASS (~493 ms). This clears the **branch ancestry and coverage regression risk in #179** but does **not** accept the stricter policy or validate the final main merge after #193. Do not merge both obsolete combined Draft #182 and #179, nor resurrect old #171/#183.

**Owner/security decision [#175](https://github.com/tim8es/cookie/issues/175) remains OPEN.** Strict transaction-scoped read serialization and documented MVCC snapshot/read-first are both viable policy choices; green tests on a candidate do not silently accept the stronger option. Explicitly record the semantics for Membership, RoleAssignment, Role and per-Location scope changes before implementation merge. Cover frontend capability/client-metadata invalidation on 403 and Organization/Location switches as a separate acceptance requirement [#66](https://github.com/tim8es/cookie/issues/66). The Workspace route exercised here is opt-in/synthetic, **not** mounted in the public production bootstrap.

## 3. Read-first Cookie guard #193 — MERGED; Chromium flake remains open

[QA PR #193](https://github.com/tim8es/cookie/pull/193) **MERGED** into current main at `476eb9a3ed80024b203898e35aab6f6a1cfb7520`. Its final PR head `083cf9bb08f4193ee194ed1dbeefa44fd42792cd` passed [full F1 CI #43932193009](https://github.com/tim8es/cookie/actions/runs/43932193009), including 103 unit, 66 real PostgreSQL 16 integrations and 46 web checks. The earlier test-only head `89d9d58e481c588c32fed82fd34e4cefba449ab5` was based on `main` `3833803c554c4e4cd5593e215ed7bb12c494ea77`. In its earlier failed F1 [run #43930722164](https://github.com/tim8es/cookie/actions/runs/43930722164), the specific protected-Workspace PostgreSQL lock regression **passed**, but another test failed with `Chrome DevToolsActivePort timed out`. Failure was **65/66** PG integrations, not an AuthN assertion failure. A retry of the **same failed job on the same PR head** passed completely: **103/103 unit, 66/66 real PG16 integration, 46/46 web**; the two-mode Workspace Cookie/Telegram revocation read-first test also passed unchanged (~998 ms). Logged in [#164](https://github.com/tim8es/cookie/issues/164).

The retry proves an earlier exact-HEAD green result **for the tested base**; it does not eliminate intermittency. The later final-head #43932193009 full CI is also green and #193 is **already merged**, so no duplicate copy should be merged. A separate **post-merge main** run is not established by these PR-head-only checks; exact main-tree verification still belongs to the release gate. This QA tests specific session/link transaction ordering; it does not resolve strict role-read #175.

## 4. Explicit merge and security acceptance

| Gate | Required observable evidence | Status |
| --- | --- | --- |
| No security-regression coverage loss | Old #179 closed; new #200 touches only five scoped files and retains all current three-mode bearer/expiry/unlink QA; verify final merge tree | **Candidate corrected in Draft #200; final merge still pending** |
| Owner selects Workspace role snapshot contract | Accepted choice recorded in issue #175, including concurrency order + forbidden-cache behavior | **OPEN** |
| Main+candidate combined CI | On **the final integrated head**, lint, Prettier, boundaries, typecheck, unit, real PG16 migration/integration and isolation/race, restore, compiled worker, Svelte/web, Chromium HTTP and browser evidence | **#200 exact-head green** (#43932202389); **pending final integration on main after #193 and owner decision** |
| Role/Booking security review | Reconcile [#113](https://github.com/tim8es/cookie/issues/113) P0 and [#165](https://github.com/tim8es/cookie/issues/165) P0 acceptance with the merged guards, independent reviewer and race matrix; do not mark PASS only from mock/synthetic production claims | **OPEN** |
| Mandatory protected `main` quality gates | Verify that PR review and exact commit required checks are **enforced by repository settings**. Issue [#144](https://github.com/tim8es/cookie/issues/144) documents previous `protected:false` and inaccessible ruleset endpoint. An Actions workflow alone **cannot enforce PR-only merges**. | **OPEN / current account settings not reverified** |
| CI launch reliability | [#164](https://github.com/tim8es/cookie/issues/164) intermittent Chromium CDP/DevToolsActivePort; isolate launcher lifecycle/health check, do not broadly retry/skip security assertions | **OPEN** |
| F1 real delivery / legal gates | Real providers, customer PII, payment flows, commercial pilot, production deployment, full retention and consent policy | **NOT AUTHORIZED** |

**Order:** (1) preserve merged main and keep old #179 closed; use only clean #200 **if strict semantics are approved**; (2) obtain #175 decision; (3) accept and revalidate #200 only if strict option selected (otherwise document/test snapshot contract); (4) retain merged #193 and other existing proofs, adding only the approved policy implementation to a frozen current main; (5) get independent security review + fully green exact-merge CI and protected-main settings; (6) then consider closure of #113/#165. No production/pilot inference at any stage.

## Evidence discipline

All technical claims are tied to GitHub PR HEADs, file blob SHA comparisons and recorded F1 Actions runs; **run results do not automatically carry forward** across base changes. PostgreSQL serialization tests use synthetic actors and two actual database connections, not real customer identities. The source of truth for F1 acceptance remains [test strategy](test-strategy.md), [F1 negative cases](f1-pilot-acceptance-cases.md), [#175](https://github.com/tim8es/cookie/issues/175) and the accepted F0/F1 boundaries in `AGENTS.md`. The exact report base is noted above; reevaluate if main advances.

## 5. Post-merge main reconciliation — #216 Chromium/Booking QA (2026-11-16)

**New verified code state:** [PR #216](https://github.com/tim8es/cookie/pull/216) was **MERGED** by a parallel owner/agent to `main` commit `24c9a601bc6359c806308777bdbe18a7a999b186`, after the repository advanced through architecture/module-boundary updates. The obsolete stacked QA Drafts #207/#209/#213 were **closed without merging**. No duplicate browser/Booking test leaf remains for separate integration.

A direct **live main Git blob comparison** confirms the merged executable QA sources are unchanged:
- `scripts/f1-chromium-startup.mjs`: blob `91ec81098ca7abfb004842ed1f20c8750f36f393`;
- `scripts/f1-chromium-startup.test.mjs`: blob `c0ec8b7a9fa9b473ddf42c01140f735d4c57c8ab`;
- `scripts/f1-browser-cdp.mjs`: blob `2821f22433b68901ac05eab52a14b09e4a37d282`;
- `apps/api/test/booking-http.integration.test.ts`: blob `1f077f2206c6f89e4c10200527e10416893f8047`.

Critically, the **merged `package.json` preserved BOTH independent scripts**: existing `pnpm test` now includes five new fail-closed CDP unit tests, **and** the newer `check:boundaries` retains `node --test scripts/check-boundaries.test.mjs`. The old #216 source package.json would otherwise have overwritten that new architecture test command; the actual GitHub merge resolved them together.

**Prior exact-PR evidence (not exact merge-SHA proof):** [full CI #43941593608](https://github.com/tim8es/cookie/actions/runs/43941593608) on test-code head and [#43942488706](https://github.com/tim8es/cookie/actions/runs/43942488706) on docs-only head were **SUCCESS**: 103 original unit + 5 CDP launcher unit, **66 PG16 integration**, **49 web**, backup/restore, worker, API/Svelte build and Chromium visual gate. These PR-head green runs do not automatically establish a full CI on the changed `main` merge commit with new architecture test scripts. On inspection, the merge commit had no attached complete Actions F1 run; **this report-only PR revision requests a new F1 check on the exact combined main-plus-doc tree**. Do not mark that newest run PASS until it completes.

**Remaining gates:** [#197](https://github.com/tim8es/cookie/issues/197) now has verified real-browser 409→fresh-body, valid empty-200 and failure-503 coverage **in main**; #164 bounded Chromium startup hardening is also **in main**, but intermittent resource/launcher root cause is not statistically disproved. Both issues remain OPEN pending independent acceptance/monitoring. Security #113/#165 and the separate #175 Workspace owner decision and #144 enforced main protection remain open. This update does not authorize public Booking/real customers, personal data, paid providers, production or commercial pilot.
