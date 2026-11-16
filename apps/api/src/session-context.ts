import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  AuthorizationDeniedError,
  type OpaqueSessionAuthority,
  type ProtectedResource,
  type TrustedActor,
} from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";

/**
 * This is a trusted AuthN port, NOT a bearer token parser/verifier. A provider
 * must cryptographically authenticate its token (signed claims or a server-
 * stored unpredictable opaque bearer), validate issuer/audience, expiry and
 * revocation and bind the selected tenant server-side before returning claims.
 */
export interface VerifiedSession {
  readonly identityId: string;
  readonly tenantId: string;
  readonly expiresAtUnixSeconds: number;
  readonly opaqueSessionAuthority?: OpaqueSessionAuthority;
}

export interface BearerSessionVerifier {
  verifyBearerToken(token: string): Promise<VerifiedSession | null>;
}

export interface TenantPolicyGuard {
  assertPermission(
    actor: TrustedActor,
    resource: ProtectedResource,
    permission: string,
  ): Promise<void>;
}

export interface ProtectedSessionDependencies {
  readonly verifier: BearerSessionVerifier;
  readonly policy: TenantPolicyGuard;
}

const SESSION_HASH_RE = /^[0-9a-f]{64}$/i;
const SESSION_LABEL_RE = /^[a-zA-Z0-9._:/-]{1,128}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  // RFC6750-compatible token alphabet; refuse multiple credentials.
  return /^Bearer ([a-zA-Z0-9._~+\x2f-]{1,4096}=*)$/i.exec(header)?.[1] ?? null;
}

/** Central fail-closed AuthN gate for opt-in HTTP adapters. */
export async function verifyTenantActor(
  authorization: string | undefined,
  pathTenantId: string,
  verifier: BearerSessionVerifier,
): Promise<
  | {
      readonly actor: TrustedActor;
      readonly status?: never;
      readonly error?: never;
    }
  | {
      readonly actor?: never;
      readonly status: 401 | 403;
      readonly error: "unauthorized" | "forbidden";
    }
> {
  const token = bearerToken(authorization);
  if (!token) return { status: 401, error: "unauthorized" };

  let session: VerifiedSession | null;
  try {
    session = await verifier.verifyBearerToken(token);
  } catch {
    return { status: 401, error: "unauthorized" };
  }
  if (
    !session ||
    !UUID_RE.test(session.tenantId) ||
    !UUID_RE.test(session.identityId) ||
    !Number.isFinite(session.expiresAtUnixSeconds) ||
    session.expiresAtUnixSeconds <= Date.now() / 1000
  ) {
    return { status: 401, error: "unauthorized" };
  }
  const authority = session.opaqueSessionAuthority;
  if (
    authority !== undefined &&
    (!authority ||
      typeof authority.tokenSha256 !== "string" ||
      typeof authority.issuer !== "string" ||
      typeof authority.audience !== "string" ||
      !SESSION_HASH_RE.test(authority.tokenSha256) ||
      !SESSION_LABEL_RE.test(authority.issuer) ||
      !SESSION_LABEL_RE.test(authority.audience))
  ) {
    return { status: 401, error: "unauthorized" };
  }
  if (pathTenantId !== session.tenantId) {
    return { status: 403, error: "forbidden" };
  }
  return {
    actor: {
      identityId: session.identityId,
      tenantId: session.tenantId,
      correlationId: randomUUID(),
      ...(authority ? { opaqueSessionAuthority: { ...authority } } : {}),
    },
  };
}

/**
 * Authenticate a server-owned tenant context before any policy check.
 * No user-submitted headers, query string, cookies or JSON become actor claims.
 * This deliberately opt-in route cannot be exposed by default API startup.
 */
export function registerProtectedSessionContext(
  app: FastifyInstance,
  dependencies: ProtectedSessionDependencies,
): void {
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/session-context",
    async (request, reply) => {
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        dependencies.verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const actor = verified.actor;
      const resource: ProtectedResource = {
        kind: "organization",
        tenantId: actor.tenantId,
      };
      try {
        await dependencies.policy.assertPermission(
          actor,
          resource,
          "organization.context.read",
        );
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          return reply.code(403).send({ error: "forbidden" });
        }
        return reply.code(503).send({ error: "unavailable" });
      }

      return reply.send({ tenantId: actor.tenantId });
    },
  );
}

/**
 * Production-mode policy implementation. Obtain DB clients per request, do
 * not silently bypass an audit or a failing policy read.
 */
export function postgresTenantPolicyGuard(pool: Pool): TenantPolicyGuard {
  return {
    async assertPermission(actor, resource, permission) {
      const client = await pool.connect();
      try {
        await requireTenantPermission(client, actor, resource, permission);
      } finally {
        client.release();
      }
    },
  };
}
