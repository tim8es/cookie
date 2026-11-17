-- Pre-organization authentication: no tenant or role is granted by this row.
CREATE TABLE cookie_identity.identity_sessions (
  token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 128),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 128),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX identity_sessions_active_by_identity
  ON cookie_identity.identity_sessions(identity_id, expires_at)
  WHERE revoked_at IS NULL;
