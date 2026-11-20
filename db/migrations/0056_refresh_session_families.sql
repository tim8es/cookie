-- Proposed synthetic-only refresh credential storage. No runtime callers.
CREATE TABLE cookie_identity.refresh_session_families (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 128),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL,
  idle_seconds integer NOT NULL CHECK (idle_seconds BETWEEN 60 AND 31536000),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  revoked_at timestamptz,
  CHECK (created_at < idle_expires_at AND idle_expires_at <= absolute_expires_at)
);
CREATE INDEX refresh_families_identity
  ON cookie_identity.refresh_session_families(identity_id,issuer,audience);
CREATE TABLE cookie_identity.refresh_session_credentials (
  token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  family_id uuid NOT NULL REFERENCES cookie_identity.refresh_session_families(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation >= 0),
  issued_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE (family_id,generation),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);
-- At most one unconsumed credential in a family. Historical hashes must be
-- retained for replay detection until the entire family is safely retired.
CREATE UNIQUE INDEX refresh_one_current_credential
  ON cookie_identity.refresh_session_credentials(family_id)
  WHERE consumed_at IS NULL;
