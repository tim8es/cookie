import type { VerifiedOwnerSession } from "./owner-auth";

export type AppearanceAssetKind = "logo" | "background";
export interface AppearanceAssetReceipt {
  id: string;
  kind: AppearanceAssetKind;
  mime: "image/png";
  width: number;
  height: number;
}

export class AppearanceAssetApiFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AppearanceAssetApiFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 2 * 1024 * 1024;
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

function invalid(): never {
  throw new AppearanceAssetApiFailure("invalid-response");
}

function dimensions(width: unknown, height: unknown): boolean {
  return (
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= 4096 &&
    height <= 4096 &&
    width * height <= 4 * 1024 * 1024
  );
}

async function request(
  session: VerifiedOwnerSession,
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  if (
    !UUID.test(session.tenantId) ||
    session.expiresAtUnixSeconds <= Date.now() / 1000
  )
    throw new AppearanceAssetApiFailure("unauthorized");
  try {
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + session.accessToken);
    return await fetcher(
      "/v1/organizations/" + session.tenantId + "/appearance/assets/" + path,
      {
        ...init,
        headers,
        signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    );
  } catch {
    throw new AppearanceAssetApiFailure("unavailable");
  }
}

function requireOk(response: Response): void {
  if (response.status === 200) return;
  const reasons: Record<number, string> = {
    400: "invalid-image",
    401: "unauthorized",
    403: "unauthorized",
    404: "unavailable",
    409: "quota",
    413: "too-large",
    415: "invalid-image",
  };
  throw new AppearanceAssetApiFailure(
    reasons[response.status] ?? "unavailable",
  );
}

export async function readAppearanceAssetCapability(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await request(
    session,
    "capability",
    { method: "GET" },
    fetcher,
    signal,
  );
  if (response.status === 403 || response.status === 404) return false;
  requireOk(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalid();
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("enabled" in body) ||
    body.enabled !== true ||
    Object.keys(body).length !== 1
  )
    return invalid();
  return true;
}

export async function uploadAppearanceAsset(
  session: VerifiedOwnerSession,
  kind: AppearanceAssetKind,
  file: Blob,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<AppearanceAssetReceipt> {
  if (!MIME.has(file.type) || file.size === 0 || file.size > MAX_BYTES)
    throw new AppearanceAssetApiFailure("invalid-image");
  const response = await request(
    session,
    kind,
    {
      method: "POST",
      headers: { "content-type": file.type },
      body: file,
    },
    fetcher,
    signal,
  );
  requireOk(response);
  try {
    const body = await response.json();
    const asset = body?.asset;
    if (
      !asset ||
      Object.keys(body).length !== 1 ||
      Object.keys(asset).length !== 5 ||
      typeof asset.id !== "string" ||
      !UUID.test(asset.id) ||
      asset.kind !== kind ||
      asset.mime !== "image/png" ||
      !dimensions(asset.width, asset.height)
    )
      return invalid();
    return {
      id: asset.id,
      kind,
      mime: "image/png",
      width: asset.width,
      height: asset.height,
    };
  } catch {
    return invalid();
  }
}

/** Private response is streamed and bounded before creating an object URL.
 * Only a normalized PNG from the authenticated same-origin API is rendered.
 */
export async function readAppearanceAssetPreview(
  session: VerifiedOwnerSession,
  kind: AppearanceAssetKind,
  id: string,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
  expected?: Pick<AppearanceAssetReceipt, "width" | "height">,
): Promise<Blob> {
  if (!UUID.test(id)) return invalid();
  const response = await request(
    session,
    kind + "/" + id,
    { method: "GET" },
    fetcher,
    signal,
  );
  requireOk(response);
  if (response.headers.get("content-type") !== "image/png" || !response.body)
    return invalid();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_BYTES) return invalid();
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (
    size < 33 ||
    !PNG.every((value, index) => bytes[index] === value) ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  )
    return invalid();
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (
    view.getUint32(8) !== 13 ||
    !dimensions(width, height) ||
    (expected && (expected.width !== width || expected.height !== height))
  )
    return invalid();
  return new Blob([bytes.slice(0, size)], { type: "image/png" });
}
