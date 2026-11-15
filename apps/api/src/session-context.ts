import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  AuthorizationDeniedError,
  type ProtectedResource,
  type TrustedActor,
} from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";

/**
 * This is a trusted AuthN port, NOT a bearer token parser/verifier. A provider
 * must validate signature, issuer, audience, expiry and revocation and bind
 * the selected tenant server-side before returning these claims.
 */
export interface VerifiedSession {
  readonly identityId: string;
  readonly tenantId: string;
  readonly expiresAtUnixSeconds: number;
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  // RFC6750-compatible token alphabet; refuse multiple credentials.
  return new RegExp("^Bearer ([a-zA-Z0-9._~+/-]{1,4096}=*)$", "i").exec(header)?.[1] ?? null;
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
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ error: "unauthorized" });

      let session: VerifiedSession | null;
      try {
        session = await dependencies.verifier.verifyBearerToken(token);
      } catch {
        return reply.code(401).send({ error: "unauthorized" });
      }

      if (
        !session ||
        !UUID_RE.test(session.tenantId) ||
        !UUID_RE.test(session.identityId) ||
        !Number.isFinite(session.expiresAtUnixSeconds) ||
        session.expiresAtUnixSeconds <= Date.now() / 1000
      ) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      // A path parameter selects a resource; it cannot select an actor tenant.
      if (request.params.tenantId !== session.tenantId) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const actor: TrustedActor = {
        identityId: session.identityId,
        tenantId: session.tenantId,
        correlationId: randomUUID(),
      };
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
