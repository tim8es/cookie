import { TransportFailure, type TransportFailureKind } from "./transport.js";

/**
 * Frontend-only state for a single CreateBooking attempt. These are not wire
 * DTOs, and this module does not define endpoints, token handling or server
 * booking rules. The future #22/#66 adapter owns schema validation.
 */
export type BookingAttemptState<Receipt, Slot> =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "confirmed"; receipt: Receipt }
  | { phase: "conflict"; slots: readonly Slot[]; refreshFailed: boolean }
  | { phase: "denied"; reason: "unauthenticated" | "forbidden" }
  | {
      phase: "error";
      reason:
        | TransportFailureKind
        | "outcome-unknown"
        | "unverified-response"
        | "unverified-conflict"
        | "idempotency-key-reused"
        | "unexpected";
      retryable: boolean;
    };

export type VerifiedBookingConflict =
  | "slot-unavailable"
  | "idempotency-key-reused"
  | "unknown";

export interface BookingAttemptPort<Selection, Receipt, Slot> {
  /**
   * Supply the exact same key on explicit retry. The backend contract decides
   * where the key goes and how long it is valid.
   */
  create(selection: Selection, idempotencyKey: string): Promise<unknown>;
  /** Return null for anything other than a schema-validated Confirmed reply. */
  verifyConfirmed(response: unknown, selection: Selection): Receipt | null;
  /**
   * A generic HTTP 409 is not enough: the reviewed backend contract may use
   * 409 both for BOOKING_CONFLICT and IDEMPOTENCY_KEY_REUSED. Only a verified
   * slot-unavailable error may trigger an availability refresh.
   * If not implemented or if verification throws, fail closed.
   */
  classifyConflict?(error: unknown): VerifiedBookingConflict;
  /** Fetch server availability again only after a verified slot conflict. */
  refreshSlots(selection: Selection): Promise<readonly Slot[]>;
}

type ActiveAttempt<Selection> = {
  selection: Selection;
  idempotencyKey: string;
};

export class BookingAttempt<Selection, Receipt, Slot> {
  private state: BookingAttemptState<Receipt, Slot> = { phase: "idle" };
  private active: ActiveAttempt<Selection> | null = null;
  private unresolved = false;
  private running: Promise<BookingAttemptState<Receipt, Slot>> | null = null;

  constructor(
    private readonly port: BookingAttemptPort<Selection, Receipt, Slot>,
    private readonly createKey: () => string,
  ) {}

  getState(): BookingAttemptState<Receipt, Slot> {
    return this.state;
  }

  /**
   * Does not silently start another mutation after an uncertain response.
   * The UI must explicitly retry the SAME key or reconcile with the server.
   */
  submit(selection: Selection): Promise<BookingAttemptState<Receipt, Slot>> {
    if (this.running) return this.running;
    if (this.state.phase !== "idle") return Promise.resolve(this.state);
    const key = this.createKey();
    if (!key.trim()) throw new Error("Missing booking attempt key");
    this.active = { selection, idempotencyKey: key };
    return this.run();
  }

  /** User-initiated retry only; never creates a second idempotency key. */
  retry(): Promise<BookingAttemptState<Receipt, Slot>> {
    if (this.running) return this.running;
    if (this.state.phase !== "error" || !this.state.retryable || !this.active) {
      return Promise.resolve(this.state);
    }
    return this.run();
  }

  /**
   * A possibly committed request must not be silently discarded and
   * re-issued with a fresh key. Reconciliation is an integration concern.
   */
  reset(): boolean {
    if (this.running || this.unresolved) return false;
    if (
      this.state.phase === "error" &&
      (this.state.retryable ||
        this.state.reason === "unverified-conflict" ||
        this.state.reason === "idempotency-key-reused")
    ) {
      return false;
    }
    this.active = null;
    this.state = { phase: "idle" };
    return true;
  }

  private run(): Promise<BookingAttemptState<Receipt, Slot>> {
    const attempt = this.active;
    if (!attempt) throw new Error("Booking attempt has not been started");
    this.state = { phase: "submitting" };
    const operation = this.perform(attempt).finally(() => {
      this.running = null;
    });
    this.running = operation;
    return operation;
  }

  private async perform(
    attempt: ActiveAttempt<Selection>,
  ): Promise<BookingAttemptState<Receipt, Slot>> {
    try {
      const response = await this.port.create(
        attempt.selection,
        attempt.idempotencyKey,
      );
      let verified: Receipt | null = null;
      try {
        verified = this.port.verifyConfirmed(response, attempt.selection);
      } catch {
        // Invalid or Pending responses cannot become success in the UI.
      }
      this.unresolved = verified === null || verified === undefined;
      this.state =
        verified === null || verified === undefined
          ? {
              phase: "error",
              reason: "unverified-response",
              retryable: true,
            }
          : { phase: "confirmed", receipt: verified };
    } catch (reason) {
      if (reason instanceof TransportFailure && reason.kind === "conflict") {
        let classification: VerifiedBookingConflict = "unknown";
        try {
          classification = this.port.classifyConflict?.(reason) ?? "unknown";
        } catch {
          // A malformed or unsupported error body is not a verified slot conflict.
        }
        if (classification === "slot-unavailable" && this.unresolved) {
          // A later rejection is not proof that the first request failed.
          this.state = {
            phase: "error",
            reason: "outcome-unknown",
            retryable: false,
          };
        } else if (classification === "slot-unavailable") {
          let slots: readonly Slot[] = [];
          let refreshFailed = false;
          try {
            slots = await this.port.refreshSlots(attempt.selection);
          } catch {
            refreshFailed = true;
          }
          this.state = { phase: "conflict", slots, refreshFailed };
        } else {
          this.state = {
            phase: "error",
            reason:
              classification === "idempotency-key-reused"
                ? "idempotency-key-reused"
                : "unverified-conflict",
            retryable: false,
          };
        }
      } else if (
        reason instanceof TransportFailure &&
        (reason.kind === "unauthenticated" || reason.kind === "forbidden")
      ) {
        this.state = this.unresolved
          ? { phase: "error", reason: "outcome-unknown", retryable: false }
          : { phase: "denied", reason: reason.kind };
      } else {
        const kind =
          reason instanceof TransportFailure ? reason.kind : "unexpected";
        const retryable =
          kind === "network" ||
          kind === "aborted" ||
          kind === "server" ||
          kind === "rate-limited" ||
          kind === "invalid-response";
        // Generic HTTP errors and unexpected exceptions are not a proof
        // that a mutation did not commit. Keep the original key reserved.
        this.unresolved = true;
        this.state = {
          phase: "error",
          reason: retryable ? kind : "outcome-unknown",
          retryable,
        };
      }
    }
    return this.state;
  }
}
