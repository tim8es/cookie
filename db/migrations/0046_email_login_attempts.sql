-- Internal distributed login throttle. Store only keyed fingerprints.
CREATE TABLE cookie_identity.email_login_attempts (
  scope text NOT NULL CHECK (scope IN ('account','source')),
  subject_hmac_sha256 bytea NOT NULL CHECK (octet_length(subject_hmac_sha256) = 32),
  window_start_epoch bigint NOT NULL CHECK (window_start_epoch >= 0),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 3600),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000001),
  PRIMARY KEY (scope, subject_hmac_sha256, window_seconds, window_start_epoch)
);
CREATE INDEX email_login_attempts_expiry
  ON cookie_identity.email_login_attempts ((window_start_epoch + window_seconds));
