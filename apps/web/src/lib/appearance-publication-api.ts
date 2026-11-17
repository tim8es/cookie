import { sameBrandConfig, type RealAppearanceDraft } from "./appearance-api";
import { validateBrandConfig, type BrandConfigV1 } from "./branding-config";
import type { VerifiedOwnerSession } from "./owner-auth";

export interface AppearancePublicationState {
  draftRevision: number;
  publishedRevision: number | null;
  canPublish: boolean;
}

export interface AppearancePublicationReceipt {
  revision: number;
  config: BrandConfigV1;
  publishedAt: string;
}

export class AppearancePublicationFailure extends Error {
  constructor(
    readonly reason:
      | "unauthorized"
      | "conflict"
      | "unavailable"
      | "invalid-response",
  ) {
    super(reason);
    this.name = "AppearancePublicationFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revision(value: unknown, min: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= min
  );
}

function invalid(): never {
  throw new AppearancePublicationFailure("invalid-response");
}

async function request(
  session: VerifiedOwnerSession,
  path: "publication" | "publish",
  body: string | undefined,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  if (
    !UUID.test(session.tenantId) ||
    session.expiresAtUnixSeconds <= Date.now() / 1000
  )
    throw new AppearancePublicationFailure("unauthorized");
  try {
    return await fetcher(
      "/v1/organizations/" + session.tenantId + "/appearance/" + path,
      {
        method: path === "publish" ? "POST" : "GET",
        headers: {
          authorization: "Bearer " + session.accessToken,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body,
        signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    );
  } catch {
    throw new AppearancePublicationFailure("unavailable");
  }
}

async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 401 || response.status === 403)
    throw new AppearancePublicationFailure("unauthorized");
  if (response.status === 409)
    throw new AppearancePublicationFailure("conflict");
  if (response.status !== 200)
    throw new AppearancePublicationFailure("unavailable");
  try {
    return await response.json();
  } catch {
    return invalid();
  }
}

/** Null means staging publication endpoint is absent, not "never published". */
export async function readAppearancePublicationState(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<AppearancePublicationState | null> {
  const response = await request(
    session,
    "publication",
    undefined,
    fetcher,
    signal,
  );
  if (response.status === 404) return null;
  const body = await responseBody(response);
  if (
    !record(body) ||
    Object.keys(body).length !== 3 ||
    !revision(body.draftRevision, 0) ||
    typeof body.canPublish !== "boolean" ||
    (body.publishedRevision !== null &&
      (!revision(body.publishedRevision, 1) ||
        body.publishedRevision > body.draftRevision))
  )
    return invalid();
  return {
    draftRevision: body.draftRevision,
    publishedRevision: body.publishedRevision,
    canPublish: body.canPublish,
  };
}

export async function publishAppearanceDraft(
  session: VerifiedOwnerSession,
  draft: RealAppearanceDraft,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<AppearancePublicationReceipt> {
  if (!revision(draft.revision, 1)) return invalid();
  const canonical = validateBrandConfig(draft.config);
  const response = await request(
    session,
    "publish",
    JSON.stringify({ expectedRevision: draft.revision }),
    fetcher,
    signal,
  );
  const body = await responseBody(response);
  if (
    !record(body) ||
    Object.keys(body).length !== 1 ||
    !record(body.published) ||
    Object.keys(body.published).length !== 3 ||
    body.published.revision !== draft.revision ||
    typeof body.published.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(body.published.publishedAt))
  )
    return invalid();
  try {
    const config = validateBrandConfig(body.published.config);
    if (!sameBrandConfig(config, canonical)) return invalid();
    return {
      revision: draft.revision,
      config,
      publishedAt: body.published.publishedAt,
    };
  } catch {
    return invalid();
  }
}
