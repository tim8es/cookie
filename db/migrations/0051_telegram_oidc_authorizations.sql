CREATE TABLE cookie_identity.telegram_oidc_authorizations (
  state_sha256 bytea PRIMARY KEY CHECK (octet_length(state_sha256)=32),
  nonce_sha256 bytea NOT NULL CHECK (octet_length(nonce_sha256)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at>created_at),
  CHECK (consumed_at IS NULL OR consumed_at>=created_at)
);

CREATE INDEX telegram_oidc_authorizations_expiry
  ON cookie_identity.telegram_oidc_authorizations(expires_at)
  WHERE consumed_at IS NULL;
