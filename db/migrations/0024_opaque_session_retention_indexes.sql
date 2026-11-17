-- F1-only additive query support for bounded opaque-session retention (#153).
-- Does not enable a maintenance job, change retention policy or delete rows.
-- The global purge selects oldest eligible rows across all tenants;
-- membership cleanup additionally filters by tenant and identity.
-- Btrees support both ORDER BY issued_at, token_sha256 ... LIMIT n
-- FOR UPDATE SKIP LOCKED queries without mandatory full-table sort.
CREATE INDEX opaque_sessions_retention_oldest_idx
  ON cookie_identity.opaque_sessions(issued_at, token_sha256);

CREATE INDEX opaque_sessions_retention_member_idx
  ON cookie_identity.opaque_sessions(tenant_id, identity_id, issued_at, token_sha256);

-- Offline F1 synthetic migration only: future populated production databases
-- require reviewed online/CONCURRENTLY index construction and write-cost budget.
