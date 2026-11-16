/**
 * Contract-neutral HTTP boundary for future #22/#66 API adapters.
 *
 * This module does NOT choose URLs, methods, headers, auth/session transport,
 * DTOs, error payload fields or booking policy. The caller must supply those
 * only after the backend contract is reviewed. In particular, this module is
 * not imported by the mock port and does not enable API mode.
 *
 * Requests are never automatically retried: an unsafe CreateBooking retry
 * requires a reviewed idempotency contract and caller-controlled key reuse.
 */
export type TransportFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "server"
  | "http"
  | "network"
  | "aborted"
  | "invalid-response";

export class TransportFailure extends Error {
  constructor(
    public readonly kind: TransportFailureKind,
    public readonly status: number | null = null,
    /** Untrusted JSON payload. Only reviewed contract mappers may interpret it. */
    public readonly responseBody: unknown = undefined,
  ) {
    // Do not leak unreviewed server response bodies, URLs or user data to UI.
    super(`HTTP transport failure: ${kind}`);
    this.name = "TransportFailure";
  }
}

/** Generic HTTP classification, NOT a backend domain-error interpretation. */
export function classifyHttpStatus(status: number): TransportFailureKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "http";
}

export interface JsonTransport {
  /** Returns unknown until a reviewed DTO mapper validates the response. */
  request(url: string | URL, init?: RequestInit): Promise<unknown>;
}

/**
 * Explicit fetch injection makes the transport fully testable offline.
 * Construction has no side effects; only request() can perform I/O.
 * The caller owns AbortSignal lifetime, credentials and any retry decision.
 */
export function createJsonTransport(fetcher: typeof fetch): JsonTransport {
  return {
    async request(url: string | URL, init?: RequestInit): Promise<unknown> {
      let response: Response;
      try {
        response = await fetcher(url, init);
      } catch (reason) {
        const aborted =
          init?.signal?.aborted ||
          (reason instanceof Error && reason.name === "AbortError");
        throw new TransportFailure(aborted ? "aborted" : "network");
      }

      if (!response.ok) {
        // Keep an untrusted JSON error body available for a future reviewed
        // domain-code parser. Never interpolate its content into UI messages.
        let responseBody: unknown;
        if (response.headers.get("content-type")?.includes("json")) {
          try {
            responseBody = (await response.json()) as unknown;
          } catch {
            // A missing or malformed body stays unverified.
          }
        }
        throw new TransportFailure(
          classifyHttpStatus(response.status),
          response.status,
          responseBody,
        );
      }

      // A successful empty response is distinct from malformed JSON.
      if (response.status === 204) return null;

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new TransportFailure("invalid-response", response.status);
      }
    },
  };
}
