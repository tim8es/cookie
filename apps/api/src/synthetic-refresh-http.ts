import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface Credentials {
  readonly familyId: string;
  readonly accessToken: string;
  readonly accessExpiresAtUnixSeconds: number;
  readonly refreshToken: string;
  readonly expiresAtUnixSeconds: number;
}

interface Candidate {
  login(initData: unknown): Promise<Credentials | null>;
  rotate(
    token: unknown,
    expectedAccessToken: string | undefined,
    expectedFamilyId: string,
  ): Promise<
    ({ status: "rotated" } & Credentials) | { status: "denied" | "replayed" }
  >;
  logout(
    token: unknown,
    expectedAccessToken: unknown,
    expectedFamilyId: string,
  ): Promise<boolean>;
}

const COOKIE = "__Host-kuki-refresh-candidate";
const REFRESH = /^ir_[A-Za-z0-9_-]{43}$/;
const ACCESS = /^Bearer (is_[A-Za-z0-9_-]{43})$/;
const PATH = "/v1/auth/synthetic-refresh";
const FAMILY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectedFamily(request: FastifyRequest): string | null {
  const value = request.headers["x-kuki-family"];
  return typeof value === "string" && FAMILY.test(value) ? value : null;
}

function privateRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header(
    "Vary",
    "Cookie, Authorization, Sec-Fetch-Site, X-Kuki-Session, X-Kuki-Family",
  );
  if (
    request.headers["sec-fetch-site"] !== "same-origin" ||
    request.headers["x-kuki-session"] !== "1"
  ) {
    reply.code(403).send({ error: "FORBIDDEN" });
    return false;
  }
  if (Object.keys(request.query as object).length !== 0) {
    reply.code(400).send({ error: "INVALID_REQUEST" });
    return false;
  }
  return true;
}

function refreshCookie(header: string | undefined): string | null {
  const matches = (header ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(COOKIE + "="));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(COOKIE.length + 1);
  return REFRESH.test(token) ? token : null;
}

function sendCredentials(reply: FastifyReply, result: Credentials) {
  const now = Math.floor(Date.now() / 1000);
  const age = result.expiresAtUnixSeconds - now;
  if (
    !FAMILY.test(result.familyId) ||
    !REFRESH.test(result.refreshToken) ||
    !/^is_[A-Za-z0-9_-]{43}$/.test(result.accessToken) ||
    !Number.isSafeInteger(age) ||
    age <= 0 ||
    age > 31536000 ||
    !Number.isSafeInteger(result.accessExpiresAtUnixSeconds) ||
    result.accessExpiresAtUnixSeconds <= now ||
    result.accessExpiresAtUnixSeconds > now + 3600 ||
    result.accessExpiresAtUnixSeconds > result.expiresAtUnixSeconds
  )
    throw new Error("Invalid candidate credentials");
  reply.header(
    "Set-Cookie",
    `${COOKIE}=${result.refreshToken}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
  return reply.code(200).send({
    tokenType: "Bearer",
    scope: "identity",
    familyId: result.familyId,
    accessToken: result.accessToken,
    expiresAtUnixSeconds: result.accessExpiresAtUnixSeconds,
  });
}

/**
 * Isolated inject-only test candidate. NEVER mount in runtime app/bootstrap.
 * The service issuer and route/cookie namespace deliberately differ from
 * live providers. A reviewed client must serialize account-changing requests
 * before any live transport can be enabled.
 */
export function registerSyntheticRefreshHttp(
  app: FastifyInstance,
  candidate: Candidate,
): void {
  app.post(PATH + "/login", async (request, reply) => {
    if (!privateRequest(request, reply)) return;
    const body: unknown = request.body;
    if (
      request.headers.authorization !== undefined ||
      request.headers["x-kuki-family"] !== undefined ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("initData" in body) ||
      typeof body.initData !== "string" ||
      Buffer.byteLength(body.initData, "utf8") > 8192
    )
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      const result = await candidate.login(body.initData);
      if (!result) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return sendCredentials(reply, result);
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });

  app.post(PATH + "/rotate", async (request, reply) => {
    if (!privateRequest(request, reply)) return;
    if (request.body !== undefined)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    const token = refreshCookie(request.headers.cookie);
    const authorization = request.headers.authorization;
    const expected = ACCESS.exec(authorization ?? "")?.[1];
    const family = expectedFamily(request);
    if (!token || !family || (authorization !== undefined && !expected))
      return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      const result = await candidate.rotate(token, expected, family);
      if (result.status !== "rotated")
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      if (result.familyId !== family)
        throw new Error("Refresh family mismatch");
      return sendCredentials(reply, result);
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });

  app.post(PATH + "/logout", async (request, reply) => {
    if (!privateRequest(request, reply)) return;
    if (request.body !== undefined)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    const token = refreshCookie(request.headers.cookie);
    const expected = ACCESS.exec(request.headers.authorization ?? "")?.[1];
    const family = expectedFamily(request);
    if (!token || !expected || !family)
      return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      if (!(await candidate.logout(token, expected, family)))
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      // Do not emit a late Set-Cookie deletion that could erase a newer
      // login. This exact family is revoked server-side; its cookie is dead.
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}
