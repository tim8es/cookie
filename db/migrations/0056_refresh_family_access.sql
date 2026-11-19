-- No live provider uses this candidate yet. Bind access to the exact family
-- and issuer/audience/Identity rather than accepting a caller-supplied actor.
ALTER TABLE cookie_identity.refresh_session_families
  ADD CONSTRAINT refresh_family_exact_scope UNIQUE (id,identity_id,issuer,audience);
ALTER TABLE cookie_identity.identity_sessions
  ADD COLUMN refresh_family_id uuid,
  ADD CONSTRAINT identity_session_refresh_family_scope
    FOREIGN KEY (refresh_family_id,identity_id,issuer,audience)
    REFERENCES cookie_identity.refresh_session_families(id,identity_id,issuer,audience)
    ON DELETE RESTRICT;
CREATE INDEX identity_sessions_by_refresh_family
  ON cookie_identity.identity_sessions(refresh_family_id)
  WHERE refresh_family_id IS NOT NULL;

-- Once a family has been revoked, no previously minted access stays live.
-- All future access-issuance paths MUST hold the family lock until COMMIT.
CREATE FUNCTION cookie_identity.revoke_refresh_family_access()
RETURNS trigger LANGUAGE plpgsql AS $refresh$
BEGIN
  WITH revoked AS (
    UPDATE cookie_identity.identity_sessions
       SET revoked_at=clock_timestamp()
     WHERE refresh_family_id=NEW.id AND revoked_at IS NULL
     RETURNING identity_id
  )
  INSERT INTO cookie_identity.auth_security_events(event_type,identity_id)
  SELECT 'identity_session_revoked',identity_id FROM revoked;
  RETURN NEW;
END;
$refresh$;
CREATE TRIGGER revoke_refresh_family_access
AFTER UPDATE OF revoked_at ON cookie_identity.refresh_session_families
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION cookie_identity.revoke_refresh_family_access();
