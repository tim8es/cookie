import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  cancelBookingInternal,
  CancelBookingFailure,
  type AssertBookingMayCancel,
} from "../../../packages/domain-booking/src/cancel.js";
import {
  rescheduleBookingInternal,
  RescheduleBookingFailure,
  type AssertBookingMayReschedule,
} from "../../../packages/domain-booking/src/reschedule.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { type BearerSessionVerifier, verifyTenantActor } from "./session-context.js";

/**
 * Strictly opt-in F1 business-side mutations. Both transaction-level policy
 * ports must be explicitly injected. No production or client/guest defaults.
 */
export interface SyntheticBookingMutationDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
  readonly assertMayCancel: AssertBookingMayCancel;
  readonly assertMayReschedule: AssertBookingMayReschedule;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
type Params = { tenantId: string; bookingId: string };
type RescheduleBody = { newStartAt: string };
type ReplyPort = { code(status: number): { send(body: unknown): unknown } };

function replyError(reply: ReplyPort, status: number, code: string): unknown {
  return reply.code(status).send({ error: { code } });
}

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= 128;
}

function validReschedule(body: unknown): body is RescheduleBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const values = body as Record<string, unknown>;
  if (Object.keys(values).length !== 1 || typeof values.newStartAt !== "string" ||
      !UTC_MINUTE.test(values.newStartAt)) return false;
  const timestamp = Date.parse(values.newStartAt);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 19) === values.newStartAt.slice(0, 19);
}

function failDomain(error: unknown, reply: ReplyPort): unknown {
  if (error instanceof AuthorizationDeniedError) {
    return replyError(reply, 403, "ACCESS_DENIED");
  }
  if (error instanceof CancelBookingFailure) {
    switch (error.code) {
      case "INVALID_CANCELLATION_COMMAND":
        return replyError(reply, 400, "INVALID_REQUEST");
      case "BOOKING_NOT_FOUND":
        return replyError(reply, 404, "BOOKING_NOT_FOUND");
      case "CANCELLATION_POLICY_DENIED":
        return replyError(reply, 403, "CANCELLATION_POLICY_DENIED");
      default:
        return replyError(reply, 409, error.code);
    }
  }
  if (error instanceof RescheduleBookingFailure) {
    switch (error.code) {
      case "INVALID_RESCHEDULE_COMMAND":
        return replyError(reply, 400, "INVALID_REQUEST");
      case "BOOKING_NOT_FOUND":
        return replyError(reply, 404, "BOOKING_NOT_FOUND");
      case "RESCHEDULE_POLICY_DENIED":
        return replyError(reply, 403, "RESCHEDULE_POLICY_DENIED");
      case "RESCHEDULE_NOT_AVAILABLE":
      case "RESCHEDULE_CONFLICT":
        return replyError(reply, 409, "BOOKING_CONFLICT");
      default:
        return replyError(reply, 409, error.code);
    }
  }
  return replyError(reply, 503, "BACKEND_UNAVAILABLE");
}

export function registerSyntheticBookingMutations(
  app: FastifyInstance,
  dependencies: SyntheticBookingMutationDependencies,
): void {
  const { pool, verifier, assertMayCancel, assertMayReschedule } = dependencies;

  app.post<{ Params: Params }>(
    "/v1/organizations/:tenantId/bookings/:bookingId/cancel",
    async (request, reply) => {
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor) {
        return replyError(reply, verified.status, verified.error === "forbidden" ? "ACCESS_DENIED" : "UNAUTHENTICATED");
      }
      if (!UUID.test(request.params.bookingId) ||
          !validKey(request.headers["idempotency-key"]) ||
          (request.body !== undefined && (request.body === null ||
            typeof request.body !== "object" || Array.isArray(request.body) ||
            Object.keys(request.body).length !== 0))) {
        return replyError(reply, 400, "INVALID_REQUEST");
      }
      try {
        const receipt = await cancelBookingInternal(
          pool,
          {
            actor: verified.actor,
            bookingId: request.params.bookingId,
            idempotencyKey: request.headers["idempotency-key"],
          },
          assertMayCancel,
        );
        return reply.code(200).send(receipt);
      } catch (error) {
        return failDomain(error, reply);
      }
    },
  );

  app.post<{ Params: Params; Body: RescheduleBody }>(
    "/v1/organizations/:tenantId/bookings/:bookingId/reschedule",
    async (request, reply) => {
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor) {
        return replyError(reply, verified.status, verified.error === "forbidden" ? "ACCESS_DENIED" : "UNAUTHENTICATED");
      }
      if (!UUID.test(request.params.bookingId) ||
          !validKey(request.headers["idempotency-key"]) ||
          !validReschedule(request.body)) {
        return replyError(reply, 400, "INVALID_REQUEST");
      }
      try {
        const receipt = await rescheduleBookingInternal(
          pool,
          {
            actor: verified.actor,
            bookingId: request.params.bookingId,
            newStartAt: request.body.newStartAt,
            idempotencyKey: request.headers["idempotency-key"],
          },
          assertMayReschedule,
        );
        return reply.code(200).send(receipt);
      } catch (error) {
        return failDomain(error, reply);
      }
    },
  );
}
