-- F1 Appearance asset storage. Only normalized bytes from a trusted server
-- codec may be inserted by the application capability. No upload/public route.
CREATE TABLE cookie_appearance.assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
    REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('logo', 'background')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
  png_bytes bytea NOT NULL CHECK (
    octet_length(png_bytes) BETWEEN 33 AND 2097152
    AND substring(png_bytes FROM 1 FOR 8) = decode('89504e470d0a1a0a', 'hex')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, sha256)
);

-- No permissive grants, raw original files, external URLs or public reads.
-- Reference integrity is a transaction protocol at the Appearance boundary:
-- save/publish take an asset row lock; delete locks the asset before checking
-- both stored configs. All callers must use those capabilities, not raw SQL.
