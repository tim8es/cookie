CREATE INDEX identity_sessions_expiry_cleanup
  ON cookie_identity.identity_sessions(expires_at, token_sha256);
