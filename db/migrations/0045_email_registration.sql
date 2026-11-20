-- Internal email/password registration candidate. Synthetic data only.
-- The independent installation key fingerprints the canonical email; raw
-- addresses, plaintext passwords and bearer challenges are never stored.
CREATE TABLE cookie_identity.email_credentials (
  email_hmac_sha256 bytea PRIMARY KEY CHECK (octet_length(email_hmac_sha256) = 32),
  identity_id uuid NOT NULL UNIQUE REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  password_hash text NOT NULL CHECK (
    length(password_hash) = 107 AND
    password_hash ~ '^scrypt-v1[$][0-9a-f]{32}[$][0-9a-f]{64}$'
  ),
  verified_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE cookie_identity.email_registration_challenges (
  token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  email_hmac_sha256 bytea NOT NULL CHECK (octet_length(email_hmac_sha256) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX email_registration_challenges_expiry
  ON cookie_identity.email_registration_challenges (expires_at);
CREATE INDEX email_registration_challenges_email
  ON cookie_identity.email_registration_challenges (email_hmac_sha256);
