import type { VerifiedOwnerSession } from "./owner-auth";

export interface WorkspaceLocation {
  readonly locationId: string;
  readonly displayName: string;
  readonly timeZone: string | null;
}

export interface RealWorkspaceOverview {
  readonly organization: {
    readonly organizationId: string;
    readonly displayName: string;
  };
  readonly locations: readonly WorkspaceLocation[];
}

export type WorkspaceOverviewFailureReason =
  | "unauthorized"
  | "unavailable"
  | "invalid-response";

export class WorkspaceOverviewFailure extends Error {
  constructor(public readonly reason: WorkspaceOverviewFailureReason) {
    super("Workspace overview failed: " + reason);
    this.name = "WorkspaceOverviewFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZONE = /^[A-Za-z][A-Za-z0-9_+./-]*$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    !!name.trim() &&
    [...name].length <= 200 &&
    !/[\p{Cc}\p{Cs}]/u.test(name)
  );
}

function validZone(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 128 || !ZONE.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validLocation(value: unknown): value is WorkspaceLocation {
  return (
    object(value) &&
    typeof value.locationId === "string" &&
    UUID.test(value.locationId) &&
    validName(value.displayName) &&
    validZone(value.timeZone)
  );
}

function decodeOverview(
  value: unknown,
  tenantId: string,
): RealWorkspaceOverview {
  if (
    !object(value) ||
    !object(value.organization) ||
    value.organization.organizationId !== tenantId ||
    !validName(value.organization.displayName) ||
    !Array.isArray(value.locations) ||
    value.locations.length > 100 ||
    !value.locations.every(validLocation) ||
    new Set(value.locations.map((location) => location.locationId)).size !==
      value.locations.length
  ) {
    throw new WorkspaceOverviewFailure("invalid-response");
  }
  // Project only the documented DTO; unknown fields are never rendered.
  return {
    organization: {
      organizationId: tenantId,
      displayName: value.organization.displayName,
    },
    locations: value.locations.map(({ locationId, displayName, timeZone }) => ({
      locationId,
      displayName,
      timeZone,
    })),
  };
}

export async function readRealWorkspaceOverview(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<RealWorkspaceOverview> {
  if (
    !UUID.test(session.tenantId) ||
    Date.now() / 1000 >= session.expiresAtUnixSeconds
  ) {
    throw new WorkspaceOverviewFailure("unauthorized");
  }

  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/workspace-overview",
      {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { authorization: "Bearer " + session.accessToken },
        signal,
      },
    );
  } catch {
    throw new WorkspaceOverviewFailure("unavailable");
  }

  if (response.status === 401 || response.status === 403) {
    throw new WorkspaceOverviewFailure("unauthorized");
  }
  if (response.status !== 200) {
    throw new WorkspaceOverviewFailure("unavailable");
  }
  try {
    return decodeOverview(await response.json(), session.tenantId);
  } catch {
    throw new WorkspaceOverviewFailure("invalid-response");
  }
}
