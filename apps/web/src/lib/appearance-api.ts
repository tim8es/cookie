import {
  validateBrandConfig,
  type BrandConfigV1,
} from "./branding-config";
import type { VerifiedOwnerSession } from "./owner-auth";

export interface RealAppearanceDraft {
  readonly revision: number;
  readonly config: BrandConfigV1;
}

export class AppearanceApiFailure extends Error {
  constructor(
    readonly reason:
      | "unauthorized"
      | "conflict"
      | "unavailable"
      | "invalid-response",
  ) {
    super("Appearance request failed: " + reason);
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decode(value: unknown): RealAppearanceDraft {
  if (
    !object(value) ||
    !object(value.draft) ||
    typeof value.draft.revision !== "number" ||
    !Number.isSafeInteger(value.draft.revision) ||
    value.draft.revision < 0
  ) {
    throw new AppearanceApiFailure("invalid-response");
  }
  try {
    return {
      revision: value.draft.revision,
      config: validateBrandConfig(value.draft.config),
    };
  } catch {
    throw new AppearanceApiFailure("invalid-response");
  }
}

export function sameBrandConfig(
  left: BrandConfigV1,
  right: BrandConfigV1,
): boolean {
  try {
    return (
      JSON.stringify(validateBrandConfig(left)) ===
      JSON.stringify(validateBrandConfig(right))
    );
  } catch {
    return false;
  }
}

async function request(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<RealAppearanceDraft> {
  if (
    !UUID.test(session.tenantId) ||
    Date.now() / 1000 >= session.expiresAtUnixSeconds
  ) {
    throw new AppearanceApiFailure("unauthorized");
  }
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/appearance/draft",
      {
        ...init,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          authorization: "Bearer " + session.accessToken,
          ...(init.headers as Record<string, string>),
        },
        signal,
      },
    );
  } catch {
    throw new AppearanceApiFailure("unavailable");
  }
  if (response.status === 401 || response.status === 403)
    throw new AppearanceApiFailure("unauthorized");
  if (response.status === 409) throw new AppearanceApiFailure("conflict");
  if (response.status !== 200) throw new AppearanceApiFailure("unavailable");
  try {
    return decode(await response.json());
  } catch {
    throw new AppearanceApiFailure("invalid-response");
  }
}

export function readRealAppearanceDraft(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<RealAppearanceDraft> {
  return request(session, fetcher, { method: "GET" }, signal);
}

export async function saveRealAppearanceDraft(
  session: VerifiedOwnerSession,
  expectedRevision: number,
  config: BrandConfigV1,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<RealAppearanceDraft> {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new AppearanceApiFailure("invalid-response");
  }
  const canonical = validateBrandConfig(config);
  const saved = await request(
    session,
    fetcher,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision, config: canonical }),
    },
    signal,
  );
  if (
    saved.revision !== expectedRevision + 1 ||
    !sameBrandConfig(saved.config, canonical)
  ) {
    throw new AppearanceApiFailure("invalid-response");
  }
  return saved;
}
