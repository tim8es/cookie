-- F1: transactional outbox owned by platform-jobs. Synthetic data only.
-- Domain producers enqueue in their existing transaction; the worker only handles
-- committed rows. This is at-least-once, never exactly-once external delivery.
CREATE SCHEMA IF NOT EXISTS cookie_jobs;

CREATE TABLE cookie_jobs.outbox_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$' AND length(topic) <= 128),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 25),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_failure_code text CHECK (last_failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT outbox_attempt_bound CHECK (attempts <= max_attempts),
  CONSTRAINT outbox_lease_state CHECK (
    (status = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CONSTRAINT outbox_delivery_state CHECK (
    (status = 'delivered') = (delivered_at IS NOT NULL)
  ),
  CONSTRAINT outbox_dedupe UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX outbox_pending_due
  ON cookie_jobs.outbox_events (available_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX outbox_leased_until
  ON cookie_jobs.outbox_events (lease_until, id)
  WHERE status = 'leased';
CREATE INDEX outbox_tenant_status
  ON cookie_jobs.outbox_events (tenant_id, status, created_at DESC);
