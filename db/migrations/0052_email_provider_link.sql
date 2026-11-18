ALTER TABLE cookie_identity.email_registration_challenges
  ADD COLUMN target_identity_id uuid
  REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT;

CREATE INDEX email_registration_link_challenges_identity
  ON cookie_identity.email_registration_challenges(target_identity_id)
  WHERE target_identity_id IS NOT NULL;
