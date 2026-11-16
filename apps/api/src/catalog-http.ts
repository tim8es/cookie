import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  CatalogInputError,
  CatalogReplayConflict,
  createTenantDraftService,
  listTenantServices,
  validateDraftService,
} from "../../../packages/domain-catalog/src/services.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import { type BearerSessionVerifier, verifyTenantActor } from "./session-context.js";

export interface RealCatalogRouteDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
type Params = { tenantId: string };

/** Authorization and SQL run in the same transaction (including revoke race). */
async function guardedTransaction<T>(
  pool: Pool,
  actor: NonNullable<Awaited<ReturnType<typeof verifyTenantActor>>["actor"]>,
  permission: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  let businessStarted = false;
  try {
    await client.query("BEGIN");
    active = true;
    await requireTenantPermission(
      client,
      actor,
      { kind: "organization", tenantId: actor.tenantId },
      permission,
    );
    businessStarted = true;
    const result = await work(client);
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (reason) {
    if (active) {
      // Persist sanitized denied-access audit only if no business write began.
      if (reason instanceof AuthorizationDeniedError && !businessStarted) {
        await client.query("COMMIT").catch(() => undefined);
      } else {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    }
    throw reason;
  } finally {
    client.release();
  }
}

/** Real, tenant-scoped draft catalog. NOT an opt-in synthetic Booking adapter. */
export function registerRealCatalogRoutes(
  app: FastifyInstance,
  { pool, verifier }: RealCatalogRouteDependencies,
): void {
  app.addHook("onRequest", async (request, reply) => {
    // Route-local paths are under /services only; no protected content in caches.
    if (!/^\/v1\/organizations\/[^/]+\/services(?:\?|$)/.test(request.url)) return;
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Authorization");
  });

  app.get<{ Params: Params }>("/v1/organizations/:tenantId/services", async (request, reply) => {
    const verified = await verifyTenantActor(
      request.headers.authorization,
      request.params.tenantId,
      verifier,
    );
    if (!verified.actor) return reply.code(verified.status).send({ error: verified.error });
    try {
      const services = await guardedTransaction(
        pool,
        verified.actor,
        "catalog.service.read",
        (client) => listTenantServices(client, verified.actor!.tenantId),
      );
      return reply.send({ services });
    } catch (reason) {
      return reply.code(reason instanceof AuthorizationDeniedError ? 403 : 503)
        .send({ error: reason instanceof AuthorizationDeniedError ? "forbidden" : "unavailable" });
    }
  });

  app.post<{ Params: Params }>("/v1/organizations/:tenantId/services", async (request, reply) => {
    const verified = await verifyTenantActor(
      request.headers.authorization,
      request.params.tenantId,
      verifier,
    );
    if (!verified.actor) return reply.code(verified.status).send({ error: verified.error });

    const key = request.headers["idempotency-key"];
    let input;
    try {
      if (typeof key !== "string" || !KEY.test(key)) throw new CatalogInputError();
      input = validateDraftService(request.body);
    } catch {
      return reply.code(400).send({ error: "invalid-request" });
    }
    try {
      const result = await guardedTransaction(
        pool,
        verified.actor,
        "catalog.service.create",
        (client) => createTenantDraftService(
          client, verified.actor!.tenantId, verified.actor!.identityId, key, input,
        ),
      );
      return reply.code(result.replayed ? 200 : 201).send({ service: result.service });
    } catch (reason) {
      if (reason instanceof CatalogReplayConflict) {
        return reply.code(409).send({ error: "idempotency-conflict" });
      }
      return reply.code(reason instanceof AuthorizationDeniedError ? 403 : 503)
        .send({ error: reason instanceof AuthorizationDeniedError ? "forbidden" : "unavailable" });
    }
  });
}
