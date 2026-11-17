-- Cookie Appearance is a business module, not minimal kernel. This schema
-- stores revisioned tenant-scoped public branding; no browser/sessionStorage
-- data or user-provided URL is an authoritative source of published settings.
-- F1 synthetic staging only until authenticated HTTP/asset gates are approved.
CREATE SCHEMA IF NOT EXISTS cookie_appearance;

CREATE TABLE cookie_appearance.organization_branding (
  tenant_id uuid PRIMARY KEY
    REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  draft_revision bigint NOT NULL
    CHECK (draft_revision >= 1),
  draft_config jsonb NOT NULL
    CHECK (jsonb_typeof(draft_config) = 'object'),
  published_revision bigint,
  published_config jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT branding_published_triple_consistent CHECK (
    (published_revision IS NULL AND published_config IS NULL AND published_at IS NULL)
    OR
    (published_revision IS NOT NULL AND published_config IS NOT NULL
      AND published_at IS NOT NULL)
  ),
  CONSTRAINT branding_publication_revision_valid CHECK (
    published_revision IS NULL OR
    (published_revision >= 1 AND published_revision <= draft_revision)
  ),
  CONSTRAINT branding_published_object CHECK (
    published_config IS NULL OR jsonb_typeof(published_config) = 'object'
  )
);

-- No permissive RLS policy or public SQL role grants. The API adapter must
-- verify AuthN + tenant policy inside the SAME transaction as every private
-- draft/save/publish call. Only published_config is projected by the future
-- public read adapter after server-side slug-to-tenant resolution.
