-- F1 synthetic-only: an explicitly reviewed/verified Telegram↔Identity link.
-- No public creation route. Real consent evidence and tenant-selection UX are
-- separately gated; a verified Telegram ID is NEVER a Customer account.
CREATE TABLE cookie_identity.telegram_identity_links (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  identity_id uuid NOT NULL,
  telegram_user_hmac_sha256 bytea NOT NULL
    CHECK (octet_length(telegram_user_hmac_sha256) = 32),
  proof_verified_at timestamptz NOT NULL,
  consent_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, identity_id, id),
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT
);

-- A Telegram ID cannot be mapped to two active identities in one tenant.
-- Multiple tenants may hold different mappings, but an unscoped login must
-- reject ambiguity instead of selecting the first or trusting client tenant.
CREATE UNIQUE INDEX telegram_link_active_tenant_user
  ON cookie_identity.telegram_identity_links(tenant_id, telegram_user_hmac_sha256)
  WHERE revoked_at IS NULL;
CREATE INDEX telegram_link_active_user
  ON cookie_identity.telegram_identity_links(telegram_user_hmac_sha256, tenant_id)
  WHERE revoked_at IS NULL;

-- Existing #146 test-only callback sessions are unlinked (NULL). All sessions
-- issued via the real DB resolver supply telegram_link_id and are bound to
-- that link AND its exact tenant/identity with an immutable composite FK.
ALTER TABLE cookie_identity.opaque_sessions
  ADD COLUMN telegram_link_id uuid;
ALTER TABLE cookie_identity.opaque_sessions
  ADD CONSTRAINT opaque_session_exact_telegram_link
    FOREIGN KEY (tenant_id, identity_id, telegram_link_id)
    REFERENCES cookie_identity.telegram_identity_links(tenant_id, identity_id, id)
    ON DELETE RESTRICT;

-- Unlink immediately revokes sessions minted through that exact link.
-- Re-enabling any link must not resurrect an existing bearer.
CREATE FUNCTION cookie_identity.revoke_sessions_on_telegram_unlink()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cookie_identity.opaque_sessions
     SET revoked_at = clock_timestamp()
   WHERE tenant_id = NEW.tenant_id
     AND identity_id = NEW.identity_id
     AND telegram_link_id = NEW.id
     AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_opaque_sessions_on_telegram_unlink
AFTER UPDATE OF revoked_at ON cookie_identity.telegram_identity_links
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION cookie_identity.revoke_sessions_on_telegram_unlink();
