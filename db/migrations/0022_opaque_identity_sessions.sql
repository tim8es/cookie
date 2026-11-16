-- F1 proposed internal-only opaque Cookie sessions. No public auth exchange.
-- Raw bearer tokens and Telegram initData MUST NOT be stored in PostgreSQL.
CREATE TABLE cookie_identity.opaque_sessions (
  token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  telegram_exchange_sha256 bytea NOT NULL UNIQUE
    CHECK (octet_length(telegram_exchange_sha256) = 32),
  tenant_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 128),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 128),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT,
  CONSTRAINT opaque_session_valid_lifetime CHECK (expires_at > issued_at)
);
CREATE INDEX opaque_sessions_by_member_active
  ON cookie_identity.opaque_sessions(tenant_id, identity_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- Once a membership is disabled, previously minted sessions cannot resurrect
-- if an administrator later re-enables the membership.
CREATE FUNCTION cookie_identity.revoke_sessions_on_membership_disable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cookie_identity.opaque_sessions
     SET revoked_at = clock_timestamp()
   WHERE tenant_id = NEW.tenant_id
     AND identity_id = NEW.identity_id
     AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_opaque_sessions_on_membership_disable
AFTER UPDATE OF active ON cookie_identity.memberships
FOR EACH ROW WHEN (OLD.active AND NOT NEW.active)
EXECUTE FUNCTION cookie_identity.revoke_sessions_on_membership_disable();
