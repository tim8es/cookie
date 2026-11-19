import {
  revokeTelegramOwnerSession,
  type VerifiedCustomerSession,
  type VerifiedOwnerSession,
} from "./owner-auth";
import {
  notifyBrowserSessionChanged,
  subscribeBrowserSessionChanges,
} from "./browser-session-events";
import type { WorkspaceHint } from "./workspace-hint";

const IDENTITY_BEARER = /^is_[A-Za-z0-9_-]{43}$/;
const TENANT_BEARER = /^cs_[A-Za-z0-9_-]{43}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IdentityAuthSession {
  readonly accessToken: string;
  readonly expiresAtUnixSeconds: number;
  /** Local UI evidence only; never used to authorize requests. */
  readonly browserBound?: boolean;
}

export interface IdentityOrganization {
  readonly tenantId: string;
  readonly organizationName: string;
  readonly roleTypes: readonly ("owner" | "admin" | "staff" | "client")[];
}

export interface AuthMethods {
  readonly email: boolean;
  readonly telegramMiniApp: boolean;
  readonly telegramWebOidc: boolean;
  readonly stagingCustomerEnrollment: boolean;
}

export function selectTelegramTransport(
  methods: AuthMethods | null,
  hasMiniAppProof: boolean,
): "mini-app" | "web" | null {
  if (methods?.telegramMiniApp && hasMiniAppProof) return "mini-app";
  return methods?.telegramWebOidc ? "web" : null;
}

export interface IdentityProviders {
  readonly email: boolean;
  readonly telegram: boolean;
}

export class IdentityAuthFailure extends Error {
  constructor(
    readonly reason:
      | "unavailable"
      | "unauthorized"
      | "invalid-response"
      | "invalid-request"
      | "registration-pending"
      | "workspace-conflict",
  ) {
    super("Identity authentication failed: " + reason);
    this.name = "IdentityAuthFailure";
  }
}

async function request(
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
  credentials: RequestCredentials = "omit",
): Promise<Response> {
  try {
    return await fetcher(path, {
      ...init,
      credentials,
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new IdentityAuthFailure("unavailable");
  }
}

function identitySession(
  value: unknown,
  nowSeconds: number,
): IdentityAuthSession {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IdentityAuthFailure("invalid-response");
  const body = value as Record<string, unknown>;
  if (
    body.tokenType !== "Bearer" ||
    body.scope !== "identity" ||
    typeof body.accessToken !== "string" ||
    !IDENTITY_BEARER.test(body.accessToken) ||
    typeof body.expiresAtUnixSeconds !== "number" ||
    !Number.isSafeInteger(body.expiresAtUnixSeconds) ||
    body.expiresAtUnixSeconds <= nowSeconds ||
    body.expiresAtUnixSeconds > nowSeconds + 3600
  ) {
    throw new IdentityAuthFailure("invalid-response");
  }
  return {
    accessToken: body.accessToken,
    expiresAtUnixSeconds: body.expiresAtUnixSeconds,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function discoverAuthMethods(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<AuthMethods> {
  const response = await request(
    "/v1/auth/methods",
    { method: "GET" },
    fetcher,
  );
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (
    !object(value) ||
    !Array.isArray(value.methods) ||
    !value.methods.every((method) => typeof method === "string") ||
    !object(value.telegram) ||
    typeof value.telegram.miniApp !== "boolean" ||
    typeof value.telegram.webOidc !== "boolean" ||
    typeof value.stagingCustomerEnrollment !== "boolean"
  ) {
    throw new IdentityAuthFailure("invalid-response");
  }
  return {
    email: value.methods.includes("email"),
    telegramMiniApp: value.telegram.miniApp,
    telegramWebOidc: value.telegram.webOidc,
    stagingCustomerEnrollment: value.stagingCustomerEnrollment,
  };
}

export async function loginEmailPassword(
  email: string,
  password: string,
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdentityAuthSession> {
  const response = await request(
    "/v1/auth/email/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    fetcher,
  );
  if (response.status === 401) throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  try {
    return identitySession(await response.json(), nowSeconds);
  } catch (error) {
    if (error instanceof IdentityAuthFailure) throw error;
    throw new IdentityAuthFailure("invalid-response");
  }
}

export async function loginTelegramMiniApp(
  initData: string,
  intent: "login" | "register",
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdentityAuthSession | VerifiedOwnerSession> {
  if (!initData || new TextEncoder().encode(initData).byteLength > 8192)
    throw new IdentityAuthFailure("unauthorized");
  const response = await request(
    "/v1/auth/telegram/identity",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData, intent }),
    },
    fetcher,
  );
  if (response.status === 401 || response.status === 403)
    throw new IdentityAuthFailure("unauthorized");
  if (![200, 201].includes(response.status))
    throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (object(value) && value.scope === "identity")
    return identitySession(value, nowSeconds);
  if (
    object(value) &&
    value.tokenType === "Bearer" &&
    value.scope === "tenant" &&
    typeof value.accessToken === "string" &&
    TENANT_BEARER.test(value.accessToken) &&
    typeof value.tenantId === "string" &&
    UUID.test(value.tenantId) &&
    typeof value.expiresAtUnixSeconds === "number" &&
    Number.isSafeInteger(value.expiresAtUnixSeconds) &&
    value.expiresAtUnixSeconds > nowSeconds &&
    value.expiresAtUnixSeconds <= nowSeconds + 3600
  ) {
    return {
      accessToken: value.accessToken,
      tenantId: value.tenantId,
      expiresAtUnixSeconds: value.expiresAtUnixSeconds,
    };
  }
  throw new IdentityAuthFailure("invalid-response");
}

export async function verifyStagingCustomerSession(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VerifiedCustomerSession> {
  try {
    const response = await request(
      `/v1/organizations/${session.tenantId}/staging-customer-context`,
      {
        method: "GET",
        headers: { authorization: "Bearer " + session.accessToken },
      },
      fetcher,
    );
    if ([401, 403, 404].includes(response.status))
      throw new IdentityAuthFailure("unauthorized");
    if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
    const value: unknown = await response.json();
    if (
      !object(value) ||
      Object.keys(value).length !== 2 ||
      value.tenantId !== session.tenantId ||
      typeof value.customerId !== "string" ||
      !UUID.test(value.customerId)
    ) {
      throw new IdentityAuthFailure("invalid-response");
    }
    return { ...session, customerId: value.customerId };
  } catch (reason) {
    // A failed tenant/customer selection must not revoke a global identity.
    if (TENANT_BEARER.test(session.accessToken)) {
      await revokeTelegramOwnerSession(session, fetcher).catch(() => undefined);
    }
    if (reason instanceof IdentityAuthFailure) throw reason;
    throw new IdentityAuthFailure("invalid-response");
  }
}

export async function startTelegramOidc(
  intent: "login" | "register" | "link",
  session?: IdentityAuthSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string> {
  const path =
    intent === "link"
      ? "/v1/auth/telegram/oidc/link/start"
      : "/v1/auth/telegram/oidc/start";
  const response = await request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { authorization: "Bearer " + session.accessToken } : {}),
      },
      body: JSON.stringify(intent === "link" ? {} : { intent }),
    },
    fetcher,
    "same-origin",
  );
  if (response.status === 401) throw new IdentityAuthFailure("unauthorized");
  if (response.status === 429) throw new IdentityAuthFailure("unavailable");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (!object(value) || typeof value.authorizationUrl !== "string")
    throw new IdentityAuthFailure("invalid-response");
  const url = new URL(value.authorizationUrl);
  if (url.origin !== "https://oauth.telegram.org" || url.pathname !== "/auth")
    throw new IdentityAuthFailure("invalid-response");
  return url.href;
}

export async function completeTelegramOidc(
  code: string,
  state: string,
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdentityAuthSession> {
  const response = await request(
    "/v1/auth/telegram/oidc/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state }),
    },
    fetcher,
    "same-origin",
  );
  if (response.status === 401 || response.status === 403)
    throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  try {
    return identitySession(await response.json(), nowSeconds);
  } catch (error) {
    if (error instanceof IdentityAuthFailure) throw error;
    throw new IdentityAuthFailure("invalid-response");
  }
}

export async function requestEmailRegistration(
  email: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/email/registration/request",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    },
    fetcher,
  );
  if (response.status !== 202) throw new IdentityAuthFailure("unavailable");
}

export async function completeEmailRegistration(
  token: string,
  password: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/email/registration/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    },
    fetcher,
  );
  if (response.status === 400) throw new IdentityAuthFailure("invalid-request");
  if (response.status !== 201) throw new IdentityAuthFailure("unavailable");
}

export async function requestEmailPasswordRecovery(
  email: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/email/password-recovery/request",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    },
    fetcher,
  );
  if (response.status !== 202) throw new IdentityAuthFailure("unavailable");
}

export async function completeEmailPasswordRecovery(
  token: string,
  password: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/email/password-recovery/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    },
    fetcher,
  );
  if (response.status === 400) throw new IdentityAuthFailure("invalid-request");
  if (response.status !== 204) throw new IdentityAuthFailure("unavailable");
}

export async function requestEmailCredentialLink(
  session: IdentityAuthSession,
  email: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/email/link/request",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email }),
    },
    fetcher,
  );
  if (response.status === 401) throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 202) throw new IdentityAuthFailure("unavailable");
}

export async function completeEmailCredentialLink(
  session: IdentityAuthSession,
  token: string,
  password: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/email/link/complete",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token, password }),
    },
    fetcher,
  );
  if (response.status === 401) throw new IdentityAuthFailure("unauthorized");
  if (response.status === 400) throw new IdentityAuthFailure("invalid-request");
  if (response.status !== 204) throw new IdentityAuthFailure("unavailable");
}

export async function linkTelegramMiniApp(
  session: IdentityAuthSession,
  initData: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (!initData || new TextEncoder().encode(initData).byteLength > 8192)
    throw new IdentityAuthFailure("unauthorized");
  const response = await request(
    "/v1/auth/telegram/link",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ initData }),
    },
    fetcher,
  );
  if (response.status === 401) throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 204) throw new IdentityAuthFailure("unavailable");
}

export async function listIdentityProviders(
  session: IdentityAuthSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<IdentityProviders> {
  const response = await request(
    "/v1/auth/identity/providers",
    {
      method: "GET",
      headers: { authorization: "Bearer " + session.accessToken },
    },
    fetcher,
  );
  if (response.status === 401) throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (
    !object(value) ||
    !object(value.providers) ||
    Object.keys(value.providers).length !== 2 ||
    typeof value.providers.email !== "boolean" ||
    typeof value.providers.telegram !== "boolean"
  ) {
    throw new IdentityAuthFailure("invalid-response");
  }
  return {
    email: value.providers.email,
    telegram: value.providers.telegram,
  };
}

export async function listIdentityOrganizations(
  session: IdentityAuthSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<IdentityOrganization[]> {
  const response = await request(
    "/v1/auth/identity/organizations",
    {
      method: "GET",
      headers: { authorization: "Bearer " + session.accessToken },
    },
    fetcher,
  );
  if (response.status === 401) throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (!object(value) || !Array.isArray(value.organizations))
    throw new IdentityAuthFailure("invalid-response");
  return value.organizations.map((entry) => {
    if (
      !object(entry) ||
      typeof entry.tenantId !== "string" ||
      !UUID.test(entry.tenantId) ||
      typeof entry.organizationName !== "string" ||
      !Array.isArray(entry.roleTypes) ||
      !entry.roleTypes.every((role) =>
        ["owner", "admin", "staff", "client"].includes(String(role)),
      )
    ) {
      throw new IdentityAuthFailure("invalid-response");
    }
    return {
      tenantId: entry.tenantId,
      organizationName: entry.organizationName,
      roleTypes: entry.roleTypes as IdentityOrganization["roleTypes"],
    };
  });
}

export async function createOwnerWorkspace(
  session: IdentityAuthSession,
  input: {
    organizationName: string;
    locationName: string;
    timeZone: string;
  },
  idempotencyKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ tenantId: string; locationId: string }> {
  const response = await request(
    "/v1/auth/owner/workspace",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        organizationName: input.organizationName,
        locationName: input.locationName,
        timeZone: input.timeZone,
      }),
    },
    fetcher,
  );
  if (response.status === 401 || response.status === 403)
    throw new IdentityAuthFailure("unauthorized");
  if (response.status === 400) throw new IdentityAuthFailure("invalid-request");
  if (response.status === 409)
    throw new IdentityAuthFailure("workspace-conflict");
  if (![200, 201].includes(response.status))
    throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (
    !object(value) ||
    typeof value.tenantId !== "string" ||
    !UUID.test(value.tenantId) ||
    typeof value.locationId !== "string" ||
    !UUID.test(value.locationId)
  ) {
    throw new IdentityAuthFailure("invalid-response");
  }
  return { tenantId: value.tenantId, locationId: value.locationId };
}

export async function enrollCustomer(
  session: IdentityAuthSession,
  tenantId: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VerifiedCustomerSession> {
  if (!UUID.test(tenantId)) throw new IdentityAuthFailure("invalid-request");
  const response = await request(
    `/v1/organizations/${tenantId}/staging-customer/enroll`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ consentConfirmed: true }),
    },
    fetcher,
  );
  if (response.status === 401 || response.status === 403)
    throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (
    !object(value) ||
    value.tenantId !== tenantId ||
    typeof value.customerId !== "string" ||
    !UUID.test(value.customerId)
  ) {
    throw new IdentityAuthFailure("invalid-response");
  }
  return {
    ...session,
    tenantId,
    customerId: value.customerId,
  };
}

export async function logoutIdentitySession(
  session: IdentityAuthSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/identity/logout",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "x-kuki-session": "1",
      },
    },
    fetcher,
    "same-origin",
  );
  notifyBrowserSessionChanged();
  if (response.status !== 204) throw new IdentityAuthFailure("unavailable");
}

/** Persist only verified global Identity credentials in a server-set cookie. */
export async function persistBrowserIdentitySession(
  session: IdentityAuthSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await request(
    "/v1/auth/browser-session",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "x-kuki-session": "1",
      },
    },
    fetcher,
    "same-origin",
  );
  if (response.status !== 204) throw new IdentityAuthFailure("unavailable");
  notifyBrowserSessionChanged();
  // Some WebViews reject Secure cookies. Verify persistence rather than
  // assuming a successful Set-Cookie response means the browser retained it.
  const restored = await restoreBrowserIdentitySession(fetcher);
  if (!restored || restored.accessToken !== session.accessToken)
    throw new IdentityAuthFailure("unavailable");
}

export async function restoreBrowserIdentitySession(
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdentityAuthSession | null> {
  const response = await request(
    "/v1/auth/browser-session",
    { method: "GET", headers: { "x-kuki-session": "1" } },
    fetcher,
    "same-origin",
  );
  if (response.status === 401 || response.status === 404) return null;
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  try {
    return identitySession(await response.json(), nowSeconds);
  } catch (error) {
    if (error instanceof IdentityAuthFailure) throw error;
    throw new IdentityAuthFailure("invalid-response");
  }
}

/**
 * Engineering transport for the disabled renewal candidate.
 * No automatic caller: the session policy and logout races need review first.
 */
export async function renewBrowserIdentitySession(
  session: IdentityAuthSession,
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdentityAuthSession | null> {
  if (
    !session.browserBound ||
    !IDENTITY_BEARER.test(session.accessToken) ||
    session.expiresAtUnixSeconds <= nowSeconds
  )
    throw new IdentityAuthFailure("unauthorized");
  const response = await request(
    "/v1/auth/browser-session/renew",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + session.accessToken,
        "x-kuki-session": "1",
      },
    },
    fetcher,
    "same-origin",
  );
  // Missing route means the installation has not enabled this candidate.
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403)
    throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  try {
    const updated = identitySession(await response.json(), nowSeconds);
    if (
      updated.accessToken !== session.accessToken ||
      updated.expiresAtUnixSeconds < session.expiresAtUnixSeconds
    )
      throw new IdentityAuthFailure("invalid-response");
    return { ...updated, browserBound: true };
  } catch (error) {
    if (error instanceof IdentityAuthFailure) throw error;
    throw new IdentityAuthFailure("invalid-response");
  }
}

/** A broadcast is only a hint. The current server cookie decides the result. */
export async function checkBrowserIdentitySession(
  session: IdentityAuthSession,
  fetcher: typeof fetch = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<"match" | "changed" | "unavailable"> {
  try {
    const current = await restoreBrowserIdentitySession(fetcher, nowSeconds);
    return current?.accessToken === session.accessToken ? "match" : "changed";
  } catch {
    return "unavailable";
  }
}

export function watchBrowserIdentitySession(
  session: IdentityAuthSession,
  invalidate: () => void,
  win: Window,
  doc: Document,
): () => void {
  if (!session.browserBound) return () => {};
  let stopped = false;
  let checking = false;
  let again = false;
  const check = async () => {
    if (stopped) return;
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    try {
      const result = await checkBrowserIdentitySession(session);
      if (!stopped && result === "changed") {
        stop();
        invalidate();
      }
    } finally {
      checking = false;
      if (again && !stopped) {
        again = false;
        void check();
      }
    }
  };
  const unsubscribe = subscribeBrowserSessionChanges(win, doc, () => {
    void check();
  });
  function stop(): void {
    stopped = true;
    unsubscribe();
  }
  return stop;
}

/** Resume only current server-confirmed memberships; never enroll on reload. */
export async function restoreWorkspaceContext(
  identity: IdentityAuthSession,
  hint: WorkspaceHint,
  organizations: readonly IdentityOrganization[],
  fetcher: typeof fetch = globalThis.fetch,
): Promise<
  | { role: "business"; session: VerifiedOwnerSession }
  | { role: "customer"; session: VerifiedCustomerSession }
> {
  if (!IDENTITY_BEARER.test(identity.accessToken) || !UUID.test(hint.tenantId))
    throw new IdentityAuthFailure("unauthorized");
  const organization = organizations.find(
    (entry) => entry.tenantId === hint.tenantId,
  );
  const session = { ...identity, tenantId: hint.tenantId };
  if (hint.role === "customer") {
    if (!organization?.roleTypes.includes("client"))
      throw new IdentityAuthFailure("unauthorized");
    return {
      role: "customer",
      session: await verifyStagingCustomerSession(session, fetcher),
    };
  }
  if (
    !organization ||
    (!organization.roleTypes.includes("owner") &&
      !organization.roleTypes.includes("admin"))
  )
    throw new IdentityAuthFailure("unauthorized");
  const response = await request(
    `/v1/organizations/${hint.tenantId}/session-context`,
    {
      method: "GET",
      headers: { authorization: "Bearer " + identity.accessToken },
    },
    fetcher,
  );
  if ([401, 403, 404].includes(response.status))
    throw new IdentityAuthFailure("unauthorized");
  if (response.status !== 200) throw new IdentityAuthFailure("unavailable");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new IdentityAuthFailure("invalid-response");
  }
  if (!object(value) || value.tenantId !== hint.tenantId)
    throw new IdentityAuthFailure("invalid-response");
  return { role: "business", session };
}
