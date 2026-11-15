import type { OutboxLease } from "./outbox.js";

export interface ProviderDelivery {
  readonly tenantId: string;
  readonly topic: string;
  readonly payload: OutboxLease["payload"];
  /** Stable over retries, lease expiry and explicit dead-letter replay. */
  readonly idempotencyKey: string;
}

/**
 * External adapters must be reviewed to establish actual provider-side
 * durability/retention of idempotency keys, not merely accept this interface.
 */
export interface IdempotentDeliveryPort {
  readonly supportsIdempotencyKey: true;
  send(event: ProviderDelivery): Promise<void>;
}

/**
 * Deliberately does not embed HTTP, Telegram, or credentials.
 * A response is a provider acceptance, not proof of customer receipt.
 */
export function idempotentProviderHandler(
  port: IdempotentDeliveryPort,
): (lease: OutboxLease) => Promise<void> {
  if (port.supportsIdempotencyKey !== true) {
    throw new Error("Delivery adapter must support a stable idempotency key");
  }
  return async (lease) => {
    await port.send({
      tenantId: lease.tenantId,
      topic: lease.topic,
      payload: lease.payload,
      idempotencyKey: "outbox:" + lease.id,
    });
  };
}
