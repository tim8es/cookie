-- F1 internal Catalog/Staff/Scheduling persistence. Synthetic data only.
-- No public query or ScheduleChange command is enabled by this migration.
-- IDs always include tenant_id in FKs; never link one tenant's rows to another.
-- Historical migrations are immutable; this file intentionally adds new tables.
CREATE SCHEMA IF NOT EXISTS cookie_catalog;
CREATE SCHEMA IF NOT EXISTS cookie_staff;
CREATE SCHEMA IF NOT EXISTS cookie_scheduling;

-- A location must be configured with a valid IANA zone by a trusted adapter.
-- NULL is deliberately NOT treated as UTC: unconfigured locations fail closed.
-- The CHECK is only syntax screening; PostgreSQL does not validate IANA names
-- here. A future tenant-scoped command must validate against supported zones.
ALTER TABLE cookie_tenancy.locations
  ADD COLUMN time_zone text
  CONSTRAINT location_time_zone_syntax CHECK (
    time_zone IS NULL OR
    (length(time_zone) BETWEEN 1 AND 128 AND
     time_zone ~ '^[A-Za-z][A-Za-z0-9_+./-]*$')
  );

-- One service identity and duration for all staff/locations of a tenant.
-- Integer kopecks avoid binary floating point; final F2 price calculation and
-- snapshot logic are a separate domain capability.
CREATE TABLE cookie_catalog.services (
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  post_service_buffer_minutes integer NOT NULL DEFAULT 0
    CHECK (post_service_buffer_minutes BETWEEN 0 AND 1440),
  base_price_kopecks bigint NOT NULL
    CHECK (base_price_kopecks BETWEEN 0 AND 999999999999),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX services_active_by_tenant
  ON cookie_catalog.services (tenant_id, id) WHERE active;

-- StaffProfile has organization-wide identity, never one copy per branch.
-- Draft/nonbookable by default until authorized publish & entitlement checks
-- have been implemented in F2.
CREATE TABLE cookie_staff.staff_profiles (
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  bookable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT staff_bookable_requires_active CHECK (NOT bookable OR active)
);

CREATE TABLE cookie_staff.location_assignments (
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, staff_id, location_id),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES cookie_staff.staff_profiles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES cookie_tenancy.locations(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX staff_by_location
  ON cookie_staff.location_assignments (tenant_id, location_id, staff_id)
  WHERE active;

-- Service assignments belong to a *specific* staff/location pairing, yet
-- duration and base price remain properties of the ONE shared Service row.
CREATE TABLE cookie_staff.service_assignments (
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  service_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, staff_id, location_id, service_id),
  FOREIGN KEY (tenant_id, staff_id, location_id)
    REFERENCES cookie_staff.location_assignments(tenant_id, staff_id, location_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, service_id)
    REFERENCES cookie_catalog.services(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX staff_for_service
  ON cookie_staff.service_assignments (tenant_id, location_id, service_id, staff_id)
  WHERE active;

-- F1 stores explicitly resolved absolute intervals. Recurring local rules and
-- DST disambiguation are NOT implemented by these tables.
CREATE TABLE cookie_scheduling.shift_windows (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id, location_id)
    REFERENCES cookie_staff.location_assignments(tenant_id, staff_id, location_id)
    ON DELETE RESTRICT,
  CONSTRAINT shift_window_valid CHECK (
    end_at > start_at AND end_at <= start_at + interval '48 hours'
  )
);
CREATE INDEX shift_windows_by_staff_location_time
  ON cookie_scheduling.shift_windows (tenant_id, staff_id, location_id, start_at, end_at)
  WHERE active;

-- Both planned breaks and exceptional unavailability are negative intervals.
-- A break need not correspond to one specific shift. Actual availability is
-- the intersection of location shifts with tenant-wide staff occupancy.
CREATE TABLE cookie_scheduling.blocked_windows (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('break', 'exception')),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id, location_id)
    REFERENCES cookie_staff.location_assignments(tenant_id, staff_id, location_id)
    ON DELETE RESTRICT,
  CONSTRAINT blocked_window_valid CHECK (
    end_at > start_at AND end_at <= start_at + interval '48 hours'
  )
);
CREATE INDEX blocked_windows_by_staff_location_time
  ON cookie_scheduling.blocked_windows (tenant_id, staff_id, location_id, start_at, end_at)
  WHERE active;

-- No public booking availability is safe until tenant-scoped authorization,
-- complete cross-location occupancy, and atomic booking command exist.
-- Shift overlap handling and safe ScheduleChange are #20/#21 review gates.
