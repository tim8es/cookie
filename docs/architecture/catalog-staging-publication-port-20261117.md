# #201 — Catalog-owned staging service publication port

F1 incremental implementation, not a new product policy or release permission.

Staff's staging publication previously locked and updated `cookie_catalog.services` itself. Catalog now owns both statements and the optimistic revision check. Its public `lockStagingServiceForPublication` takes the already authorized transaction's PoolClient, tenant and service IDs and expected revision. The returned ready capability defers activation until Staff has checked the branch and exact assignments; already active services remain unchanged. Missing/stale results map to the previous Staff errors.

There is no new database transaction, network call or asynchronous event. The Staff workflow preserves its existing staff → authorization → grant → service → branch/assignment lock sequence and receipt/revocation handling. The activation capability is internal, cannot be accepted from HTTP, and must never escape the caller's transaction. No staging grant, permission, pilot or configuration behavior changes.

Unit fixtures check missing/stale revisions, deferred activation with tenant/service scope, repeated activation on the locked port and reuse of active services. Existing PostgreSQL staging publication integration tests must also pass before merge. This removes one cross-module table writer and its paired read; it does not establish global SQL ownership enforcement or eliminate other cross-schema dependencies.
