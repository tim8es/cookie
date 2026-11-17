import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  AppearanceAssetNotVerified,
  AppearanceRevisionConflict,
  publishTenantBrandDraft,
  readTenantBrandDraft,
  saveTenantBrandDraft,
  validateBrandConfig,
  type TenantAssetOwnership,
} from "../../../packages/domain-appearance/src/index.js";
import {
  AuthorizationDeniedError,
  type TrustedActor,
} from "../../../packages/platform-identity/src/index.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";

type TenantParams = { tenantId: string };
type DraftBody = { expectedRevision: number; config: unknown };
type PublishBody = { expectedRevision: number };

export interface RealAppearanceRouteDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
  readonly assets?: TenantAssetOwnership;
  readonly draftOnly?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revision(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0)
  );
}

/**
 * Every route uses the verified session's tenant ID and a same-transaction
 * permission check. The normal API bootstrap must register this adapter only
 * after a real cryptographic/verifiable Identity provider is installed.
 */
export function registerRealAppearanceRoutes(
  app: FastifyInstance,
  {
    pool,
    verifier,
    assets,
    draftOnly = false,
  }: RealAppearanceRouteDependencies,
): void {
  async function authenticated(
    authorization: string | undefined,
    tenantId: string,
  ): Promise<
    | {
        readonly actor: TrustedActor;
        readonly status?: never;
        readonly error?: never;
      }
    | {
        readonly actor?: never;
        readonly status: 401 | 403;
        readonly error: string;
      }
  > {
    const result = await verifyTenantActor(authorization, tenantId, verifier);
    if (!result.actor) {
      return {
        status: result.status,
        error: result.error,
      };
    }
    return { actor: result.actor };
  }

  function failure(error: unknown): {
    readonly status: 403 | 409 | 503;
    readonly error: string;
  } {
    if (error instanceof AuthorizationDeniedError) {
      return { status: 403, error: "forbidden" };
    }
    if (error instanceof AppearanceRevisionConflict) {
      return { status: 409, error: "stale-revision" };
    }
    if (error instanceof AppearanceAssetNotVerified) {
      return { status: 409, error: "asset-not-verified" };
    }
    // SQL messages and asset provider details must never reach clients.
    return { status: 503, error: "unavailable" };
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!/^\/v1\/organizations\/[^/]+\/appearance(?:\/|\?|$)/.test(request.url))
      return;
    reply.header("Cache-Control", "no-store");
    reply.header("Vary", "Authorization");
  });

  app.get<{ Params: TenantParams }>(
    "/v1/organizations/:tenantId/appearance/draft",
    async (request, reply) => {
      const verified = await authenticated(
        request.headers.authorization,
        request.params.tenantId,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      try {
        const result = await withTenantPermission(
          pool,
          verified.actor,
          "appearance.read",
          (client) => readTenantBrandDraft(client, verified.actor!.tenantId),
        );
        return reply.send({ draft: result });
      } catch (error) {
        const result = failure(error);
        return reply.code(result.status).send({ error: result.error });
      }
    },
  );

  app.put<{ Params: TenantParams; Body: DraftBody }>(
    "/v1/organizations/:tenantId/appearance/draft",
    async (request, reply) => {
      const verified = await authenticated(
        request.headers.authorization,
        request.params.tenantId,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const body: unknown = request.body;
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, "expectedRevision") ||
        !Object.hasOwn(body, "config") ||
        !revision(body.expectedRevision, true)
      ) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      let config;
      try {
        config = validateBrandConfig(body.config);
      } catch {
        return reply.code(400).send({ error: "invalid-branding" });
      }
      try {
        const result = await withTenantPermission(
          pool,
          verified.actor,
          "appearance.manage",
          (client) =>
            saveTenantBrandDraft(
              client,
              verified.actor!.tenantId,
              body.expectedRevision as number,
              config,
              assets,
            ),
        );
        return reply.send({ draft: result });
      } catch (error) {
        const result = failure(error);
        return reply.code(result.status).send({ error: result.error });
      }
    },
  );

  // Runtime draft editing does not confer the publication entitlement.
  if (draftOnly) return;

  app.post<{ Params: TenantParams; Body: PublishBody }>(
    "/v1/organizations/:tenantId/appearance/publish",
    async (request, reply) => {
      const verified = await authenticated(
        request.headers.authorization,
        request.params.tenantId,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const body: unknown = request.body;
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 1 ||
        !Object.hasOwn(body, "expectedRevision") ||
        !revision(body.expectedRevision, false)
      ) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        const result = await withTenantPermission(
          pool,
          verified.actor,
          "appearance.publish",
          (client) =>
            publishTenantBrandDraft(
              client,
              verified.actor!.tenantId,
              body.expectedRevision as number,
              assets,
            ),
        );
        return reply.send({ published: result });
      } catch (error) {
        const result = failure(error);
        return reply.code(result.status).send({ error: result.error });
      }
    },
  );
}
