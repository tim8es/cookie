-- Proposed F1 review-only preparation. No session or provider reads this table.
-- Explicit cleanup/retention must be designed before any live use.
CREATE TABLE cookie_identity.legacy_telegram_migration_preparations (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  legacy_link_id uuid NOT NULL,
  proof_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(proof_sha256) = 32),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, identity_id, legacy_link_id)
    REFERENCES cookie_identity.telegram_identity_links(tenant_id, identity_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX legacy_telegram_preparations_by_link
  ON cookie_identity.legacy_telegram_migration_preparations(tenant_id,identity_id,legacy_link_id);
