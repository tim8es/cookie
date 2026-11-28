import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * Route-local handling for transport errors before the staging mutation
 * handler runs. HTTP status codes are preserved; parser details never
 * become customer-visible response data. No authorization is inferred
 * from a parser rejection, and no database operation is attempted here.
 */
export function stagingBookingTransportError(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
  switch (error.statusCode) {
    case 400:
      void reply.code(400).send({ error: "invalid-request" });
      return;
    case 413:
      void reply.code(413).send({ error: "payload-too-large" });
      return;
    case 415:
      void reply.code(415).send({ error: "unsupported-media-type" });
      return;
    default:
      // Keep the framework's existing behavior for other errors.
      void reply.send(error);
  }
}
