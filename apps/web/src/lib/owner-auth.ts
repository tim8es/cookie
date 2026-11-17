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

export type OwnerAuthFailureReason =
  | "unauthorized"
  | "unavailable"
  | "invalid-response";
export class OwnerAuthFailure extends Error {
  constructor(public readonly reason: OwnerAuthFailureReason) {
    super("Owner authentication failed: " + reason);
    this.name = "OwnerAuthFailure";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE_BEARER = /^cs_[A-Za-z0-9_-]{43}$/;

type TelegramWindow = Window & {
  Telegram?: { WebApp?: { initData?: unknown } };
};

/** Unknown providers are ignored until this client implements them. */
export async function telegramLoginAvailable(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const response = await request(fetcher, "/v1/auth/methods", {
    method: "GET",
  });
  if (response.status !== 200) throw new OwnerAuthFailure("unavailable");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OwnerAuthFailure("invalid-response");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OwnerAuthFailure("invalid-response");
  }
  const methods = (body as { methods?: unknown }).methods;
  if (
    !Array.isArray(methods) ||
    !methods.every((value) => typeof value === "string")
  ) {
    throw new OwnerAuthFailure("invalid-response");
  }
  return methods.includes("telegram");
}

/** Never read proof from URL, localStorage, manually entered fields or preview mode. */
export function readTelegramInitData(win: Window | undefined): string | null {
  const raw = (win as TelegramWindow | undefined)?.Telegram?.WebApp?.initData;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The Telegram object is not available until the official WebApp script runs.
 * Load it only after the caller selected real API mode. Mock previews must not
 * load any external SDK, and its contents never count as authenticated claims.
 */
export async function loadTelegramInitData(
  win: Window,
  doc: Document,
): Promise<string | null> {
  const existing = readTelegramInitData(win);
  if (existing) return existing;

  return new Promise((resolve) => {
    const script = doc.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    script.referrerPolicy = "no-referrer";

    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      win.clearTimeout(timeout);
      resolve(readTelegramInitData(win));
    };
    const timeout = win.setTimeout(finish, 7_000);
    script.onload = finish;
    script.onerror = finish;
    doc.head.append(script);
  });
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
export async function exchangeTelegramSession(
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

  return session;
}

export async function authenticateTelegramOwner(
  rawInitData: string,
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedOwnerSession> {
  const session = await exchangeTelegramSession(
    rawInitData,
    fetcher,
    nowSeconds,
  );
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

/** Clear every owner page at expiry, including after suspended-tab resume. */
export function watchOwnerSessionExpiry(
  expiresAtUnixSeconds: number,
  onExpire: () => void,
  win: Window,
  doc: Document,
  now = Date.now,
): () => void {
  let timer: number | undefined;
  let stopped = false;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) win.clearTimeout(timer);
    win.removeEventListener("focus", check);
    win.removeEventListener("pageshow", check);
    doc.removeEventListener("visibilitychange", check);
  }

  function check(): void {
    if (stopped) return;
    if (timer !== undefined) win.clearTimeout(timer);
    const remaining = expiresAtUnixSeconds * 1000 - now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      stop();
      onExpire();
      return;
    }
    timer = win.setTimeout(check, Math.min(remaining, 2147483647));
  }

  win.addEventListener("focus", check);
  win.addEventListener("pageshow", check);
  doc.addEventListener("visibilitychange", check);
  check();
  return stop;
}

export interface VerifiedCustomerSession extends VerifiedOwnerSession {
  readonly customerId: string;
}

/** Same real HMAC exchange; distinct server-owned client relation, not an owner fallback. */
export async function authenticateTelegramCustomer(
  rawInitData: string,
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedCustomerSession> {
  const session = await exchangeTelegramSession(
    rawInitData,
    fetcher,
    nowSeconds,
  );
  try {
    const context = await request(
      fetcher,
      "/v1/organizations/" + session.tenantId + "/staging-customer-context",
      {
        method: "GET",
        headers: { authorization: "Bearer " + session.accessToken },
      },
    );
    if ([401, 403, 404].includes(context.status))
      throw new OwnerAuthFailure("unauthorized");
    if (context.status !== 200) throw new OwnerAuthFailure("unavailable");
    const data: unknown = await context.json();
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).length !== 2 ||
      !("tenantId" in data) ||
      data.tenantId !== session.tenantId ||
      !("customerId" in data) ||
      typeof data.customerId !== "string" ||
      !UUID.test(data.customerId)
    )
      throw new OwnerAuthFailure("invalid-response");
    return { ...session, customerId: data.customerId };
  } catch (reason) {
    await revokeTelegramOwnerSession(session, fetcher).catch(() => undefined);
    if (reason instanceof OwnerAuthFailure) throw reason;
    throw new OwnerAuthFailure("invalid-response");
  }
}
