# F1 #165 + #175 — optional combined review gate for strict Workspace reads

**Status: DRAFT REVIEW OPTION, not a policy decision, not merged, not production.**

## Exact stack

- Base: #180 at `a3c0f753446955b495db71ad6f7677c194247b04` (the independent #165 revoke,
  expiry, membership-disable and positive Booking tests), with complete
  F1 CI [#43920123267](https://github.com/tim8es/cookie/actions/runs/43920123267) PASS.
- Adds only the source fix and unchanged independent QA regression
  from #179/#176 to establish a **strict transaction-scoped** Workspace
  read policy. The original QA test is byte-for-byte identical to
  #176 source blob `342302318473e08746676cd9c475c1944856d7e1`.
- No changes to the #165 booking/revocation/expiry tests, session verifier,
  migrations, payment/provider interfaces, UI code or CI workflow.

## Independent contract decision still required

Issue #175 explicitly identifies two possible legal linearization
contracts for overlapping reads and role-revocation transactions:

1. **Strict transaction-boundary option (this draft):** lock canonical
   organization/membership/assignment/role rows before Telegram
   link/opaque session authority, and hold those locks through the
   Workspace response's PostgreSQL transaction. A role revoke that
   commits first denies; when a read acquired locks first, revoke
   waits until that read COMMIT and the read may return 200.
2. **Snapshot/read-first alternative:** allow a read begun before
   revocation to finish based on its immutable SQL snapshot, but
   explicitly document that linearization point, test revoke-first
   denied/no metadata and implement frontend cache invalidation.

**Do not merge this draft as an unrecorded selection of option 1.**
The responsible owner/security reviewer must explicitly record the
chosen semantics in #175 before merging the Workspace read fix.
No runtime production path is mounted by these opt-in synthetic APIs.

## Acceptance evidence required

A single exact-head F1 CI must verify the combined test suite, not
separately green PRs: revoke-first Cookie bearer, expiry, Telegram
unlink, positive Booking 201 and idempotent replay, membership-disable
deadlock freedom, and the strict Workspace role-revocation race.
Review should verify independent QA test blobs and absence of source
conflicts. Branch protection #144, frontend sensitive cache invalidation,
security/PDn/legal and provider gates remain open regardless of CI.
