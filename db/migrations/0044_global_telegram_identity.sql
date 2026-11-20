-- Verified global authentication is separate from tenant-specific role links.
CREATE TABLE cookie_identity.global_telegram_identities (
  telegram_user_hmac_sha256 bytea PRIMARY KEY CHECK (octet_length(telegram_user_hmac_sha256) = 32),
  identity_id uuid NOT NULL UNIQUE REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cookie_identity.global_telegram_exchanges (
  proof_sha256 bytea PRIMARY KEY CHECK (octet_length(proof_sha256) = 32),
  identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
