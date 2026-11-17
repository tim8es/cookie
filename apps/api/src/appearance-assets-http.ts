import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Pool } from "pg";

import {
  AppearanceCodecFailure,
  AppearanceStorageQuotaExceeded,
  normalizeAppearanceImage,
  readTenantAppearanceAsset,
  storeAppearanceAssetWithinQuota,
  validateAppearanceStorageQuota,
  type AppearanceStorageQuota,
} from "../../../packages/appearance-asset-adapter/src/index.js";
import type { AssetKind } from "../../../packages/domain-appearance/src/index.js";
import {
  AuthorizationDeniedError,
  type TrustedActor,
} from "../../../packages/platform-identity/src/index.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];
const ROOT = "/v1/organizations/:tenantId/appearance/assets";
type Params = { tenantId: string; kind: string };
type ReadParams = Params & { assetId: string };

export interface PrivateAppearanceAssetsDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
  /** Operator-selected technical bounds, not a customer tariff/default. */
  readonly quota: AppearanceStorageQuota;
}

function kindOf(value: string): AssetKind | null {
  return value === "logo" || value === "background" ? value : null;
}

function privateHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Vary", "Authorization");
  reply.header("X-Content-Type-Options", "nosniff");
}

function failure(reply: FastifyReply, reason: unknown) {
  if (reason instanceof AuthorizationDeniedError)
    return reply.code(403).send({ error: "forbidden" });
  if (reason instanceof AppearanceStorageQuotaExceeded)
    return reply.code(409).send({ error: "appearance-storage-quota" });
  if (reason instanceof AppearanceCodecFailure) {
    if (reason.code === "invalid-image")
      return reply.code(400).send({ error: "invalid-image" });
    if (reason.code === "output-too-large")
      return reply.code(413).send({ error: "output-too-large" });
  }
  return reply.code(503).send({ error: "unavailable" });
}

/** Explicitly opt-in only. Do NOT register in ordinary main.ts until
 * independently reviewed OS/ingress isolation and runtime gates are met.
 */
export function registerPrivateAppearanceAssetRoutes(
  app: FastifyInstance,
  dependencies: PrivateAppearanceAssetsDependencies,
): void {
  const { pool, verifier } = dependencies;
  const quota = validateAppearanceStorageQuota(dependencies.quota);
  // Scope binary parsers, error mapping and admission to this plugin only.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      TYPES,
      { parseAs: "buffer", bodyLimit: MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    scope.setErrorHandler((error, _request, reply) => {
      privateHeaders(reply);
      const code =
        typeof error === "object" && error !== null && "statusCode" in error
          ? error.statusCode
          : undefined;
      const status = code === 413 ? 413 : code === 415 ? 415 : 400;
      return reply.code(status).send({ error: "invalid-upload" });
    });

    let admitted: FastifyRequest | null = null;
    let running = false;
    function release(request: FastifyRequest): void {
      if (admitted === request && !running) admitted = null;
    }
    scope.addHook("onResponse", async (request) => release(request));
    scope.addHook("onRequestAbort", async (request) => release(request));

    scope.post<{ Params: Params; Body: Buffer }>(
      ROOT + "/:kind",
      {
        bodyLimit: MAX_BYTES,
        onRequest: async (request, reply) => {
          privateHeaders(reply);
          if (
            !kindOf(request.params.kind) ||
            Object.keys(request.query as object).length !== 0
          )
            return reply.code(400).send({ error: "invalid-request" });
          if (
            typeof request.headers["content-type"] !== "string" ||
            !TYPES.includes(request.headers["content-type"]) ||
            request.headers["content-encoding"] !== undefined
          )
            return reply.code(415).send({ error: "invalid-upload" });
          // No queue, no aggregate unbounded body buffering. Admission
          // precedes asynchronous auth and parsing, and lasts through work.
          if (admitted)
            return reply.code(503).send({ error: "unavailable" });
          admitted = request;
          try {
            const verified = await verifyTenantActor(
              request.headers.authorization,
              request.params.tenantId,
              verifier,
            );
            if (!verified.actor)
              return reply.code(verified.status).send({ error: verified.error });
            if (!verified.actor.opaqueSessionAuthority)
              return reply.code(403).send({ error: "forbidden" });
            await withTenantPermission(
              pool,
              verified.actor,
              "appearance.manage",
              async () => undefined,
            );
          } catch (error) {
            return failure(reply, error);
          }
        },
      },
      async (request, reply) => {
        // An aborted pre-handler request cannot reacquire admission.
        if (admitted !== request)
          return reply.code(503).send({ error: "unavailable" });
        running = true;
        try {
          const kind = kindOf(request.params.kind);
          if (!kind || !Buffer.isBuffer(request.body))
            return reply.code(400).send({ error: "invalid-upload" });
          const image = await normalizeAppearanceImage(
            request.body,
            request.headers["content-type"]!,
          );
          // Re-authenticate after native work and recheck permission inside
          // the same transaction as storage, not using stale preflight.
          const verified = await verifyTenantActor(
            request.headers.authorization,
            request.params.tenantId,
            verifier,
          );
          if (!verified.actor)
            return reply.code(verified.status).send({ error: verified.error });
          const actor: TrustedActor = verified.actor;
          if (!actor.opaqueSessionAuthority)
            return reply.code(403).send({ error: "forbidden" });
          const asset = await withTenantPermission(
            pool,
            actor,
            "appearance.manage",
            (client) =>
              storeAppearanceAssetWithinQuota(
                client,
                actor.tenantId,
                kind,
                image,
                quota,
              ),
          );
          return reply.code(200).send({ asset });
        } catch (error) {
          return failure(reply, error);
        } finally {
          running = false;
          release(request);
        }
      },
    );

    scope.get<{ Params: ReadParams }>(
      ROOT + "/:kind/:assetId",
      async (request, reply) => {
        privateHeaders(reply);
        const kind = kindOf(request.params.kind);
        if (!kind || Object.keys(request.query as object).length !== 0)
          return reply.code(400).send({ error: "invalid-request" });
        const verified = await verifyTenantActor(
          request.headers.authorization,
          request.params.tenantId,
          verifier,
        );
        if (!verified.actor)
          return reply.code(verified.status).send({ error: verified.error });
        if (!verified.actor.opaqueSessionAuthority)
          return reply.code(403).send({ error: "forbidden" });
        const actor = verified.actor;
        try {
          const asset = await withTenantPermission(
            pool,
            actor,
            "appearance.read",
            (client) =>
              readTenantAppearanceAsset(
                client,
                actor.tenantId,
                request.params.assetId,
                kind,
              ),
          );
          if (!asset) return reply.code(404).send({ error: "not-found" });
          return reply.type("image/png").send(asset.bytes);
        } catch (error) {
          return failure(reply, error);
        }
      },
    );
  });
}
