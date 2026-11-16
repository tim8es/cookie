/**
 * Real owner authentication is an independent, opt-in vertical slice.
 * No browser persistence, tenant selection, token in URL or implicit retries.
 * The server (not Telegram client JS) authenticates and authorizes the owner.
 */
export interface VerifiedOwnerSession {
  readonly accessToken: string;
  readonly tenantId: string;
  readonly expiresAtUnixSeconds: number;
}

export type OwnerAuthFailureReason = "unauthorized" | "unavailable" | "invalid-response";
export class OwnerAuthFailure extends Error {
  constructor(public readonly reason: OwnerAuthFailureReason) {
    super("Owner authentication failed: " + reason);
    this.name = "OwnerAuthFailure";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE_BEARER = /^cs_[A-Za-z0-9_-]{43}$/;

type TelegramWindow = Window & {
  Telegram?: { WebApp?: { initData?: unknown } };
};

/** Never read proof from URL, localStorage, manually entered fields or preview mode. */
export function readTelegramInitData(win: Window | undefined): string | null {
  const raw = (win as TelegramWindow | undefined)?.Telegram?.WebApp?.initData;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new OwnerAuthFailure("unavailable");
  }
}

function validSession(body: unknown, nowSeconds: number): VerifiedOwnerSession {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OwnerAuthFailure("invalid-response");
  }
  const candidate = body as Record<string, unknown>;
  if (
    candidate.tokenType !== "Bearer" ||
    typeof candidate.accessToken !== "string" ||
    !COOKIE_BEARER.test(candidate.accessToken) ||
    typeof candidate.tenantId !== "string" ||
    !UUID.test(candidate.tenantId) ||
    typeof candidate.expiresAtUnixSeconds !== "number" ||
    !Number.isInteger(candidate.expiresAtUnixSeconds) ||
    candidate.expiresAtUnixSeconds <= nowSeconds ||
    candidate.expiresAtUnixSeconds > nowSeconds + 3600
  ) {
    throw new OwnerAuthFailure("invalid-response");
  }
  return {
    accessToken: candidate.accessToken,
    tenantId: candidate.tenantId,
    expiresAtUnixSeconds: candidate.expiresAtUnixSeconds,
  };
}

/** One-time Telegram signed proof -> bearer -> verified tenant context. */
export async function authenticateTelegramOwner(
  rawInitData: string,
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedOwnerSession> {
  if (!rawInitData || new TextEncoder().encode(rawInitData).byteLength > 8192) {
    throw new OwnerAuthFailure("unauthorized");
  }

  const exchanged = await request(fetcher, "/v1/auth/telegram/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: rawInitData }),
  });
  if (exchanged.status === 401 || exchanged.status === 403) {
    throw new OwnerAuthFailure("unauthorized");
  }
  if (exchanged.status !== 201) {
    throw new OwnerAuthFailure("unavailable");
  }

  let session: VerifiedOwnerSession;
  try {
    session = validSession(await exchanged.json(), nowSeconds);
  } catch {
    throw new OwnerAuthFailure("invalid-response");
  }

  try {
    const context = await request(
      fetcher,
      "/v1/organizations/" + session.tenantId + "/session-context",
      {
        method: "GET",
        headers: { authorization: "Bearer " + session.accessToken },
      },
    );
    if (context.status === 401 || context.status === 403) {
      throw new OwnerAuthFailure("unauthorized");
    }
    if (context.status !== 200) {
      throw new OwnerAuthFailure("unavailable");
    }
    const json: unknown = await context.json();
    if (
      !json ||
      typeof json !== "object" ||
      Array.isArray(json) ||
      (json as { tenantId?: unknown }).tenantId !== session.tenantId
    ) {
      throw new OwnerAuthFailure("invalid-response");
    }
  } catch (reason) {
    // Even if context verification failed, try to revoke the issued bearer.
    // Failure to revoke never turns an unauthenticated page into success.
    await revokeTelegramOwnerSession(session, fetcher).catch(() => undefined);
    if (reason instanceof OwnerAuthFailure) throw reason;
    throw new OwnerAuthFailure("invalid-response");
  }

  return session;
}

/**
 * Server logout must be confirmed by HTTP 204. The caller discards its
 * in-memory credential even when network/server revocation fails.
 */
export async function revokeTelegramOwnerSession(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const result = await request(fetcher, "/v1/auth/logout", {
    method: "POST",
    headers: { authorization: "Bearer " + session.accessToken },
  });
  if (result.status !== 204) {
    throw new OwnerAuthFailure("unavailable");
  }
}
