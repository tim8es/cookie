import type { BookingAttemptPort } from "./booking-attempt";
import type { ConfirmedBookingReceiptView } from "./booking-attempt-view";
import {
  classifyProposedF1Conflict,
  parseProposedF1Availability,
  proposedF1ReceiptView,
  type ProposedF1Availability,
  type ProposedF1AvailableSlot,
} from "./proposed-f1-synthetic-wire";
import { createJsonTransport, TransportFailure } from "./transport";

/**
 * TEST-HARNESS ONLY: transport adapter for the PROPOSED, opt-in, staff-assisted
 * F1 synthetic HTTP routes (backend Draft #100 → #110 → #116).
 *
 * Not imported from App.svelte or api.ts. Production AuthN, client ownership,
 * entitlement and real customer sessions are ABSENT. This adapter must NOT
 * be used for a public/mobile/Telegram booking or exposed outside loopback.
 */
export interface ProposedF1SyntheticHarness {
  /** An ephemeral local test listener, e.g. http://127.0.0.1:41234. */
  origin: string;
  /** Verified by the synthetic test server, never derived from web input. */
  tenantId: string;
  /** A pre-created synthetic Customer FK, NOT a user's identity. */
  syntheticCustomerId: string;
  /** An injected test-only bearer, not a browser/Telegram credential. */
  syntheticBearer: string;
  /** Explicit injection; importing this module cannot perform any network I/O. */
  fetcher: typeof fetch;
}

export interface ProposedF1SyntheticSelection {
  locationId: string;
  staffId: string;
  serviceId: string;
  /** A UTC minute, taken from previously returned backend availability. */
  startAt: string;
  /** IANA Location's local day; caller must derive from trusted server data. */
  localDate: string;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ATTEMPT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TEST_BEARER = /^[A-Za-z0-9._~+/-]{1,512}$/;

function utcMinute(value: string): boolean {
  if (!UTC_MINUTE.test(value)) return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function localDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function checkUuid(value: string, description: string): void {
  if (!UUID.test(value)) throw new Error("Invalid synthetic " + description);
}

function checkSelection(value: ProposedF1SyntheticSelection): void {
  checkUuid(value.locationId, "location");
  checkUuid(value.serviceId, "service");
  checkUuid(value.staffId, "staff");
  if (!utcMinute(value.startAt) || !localDate(value.localDate)) {
    throw new Error("Invalid synthetic UTC time or location-local date");
  }
}

/**
 * Explicitly refuses remote origins, paths, query credentials or fragments.
 * This test-only safety gate is not an alternative to production AuthN.
 */
export function createProposedF1SyntheticLoopbackClient(config: ProposedF1SyntheticHarness): {
  port: BookingAttemptPort<
    ProposedF1SyntheticSelection,
    ConfirmedBookingReceiptView,
    ProposedF1AvailableSlot
  >;
  readAvailability(selection: ProposedF1SyntheticSelection): Promise<ProposedF1Availability>;
} {
  const origin = new URL(config.origin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("Synthetic F1 transport requires an ephemeral 127.0.0.1 HTTP origin");
  }
  checkUuid(config.tenantId, "tenant");
  checkUuid(config.syntheticCustomerId, "customer");
  if (!TEST_BEARER.test(config.syntheticBearer)) {
    throw new Error("Invalid test-only bearer");
  }

  const root = origin.origin + "/v1/organizations/" + config.tenantId;
  const transport = createJsonTransport(config.fetcher);
  const headers = {
    Authorization: "Bearer " + config.syntheticBearer,
  };

  async function readAvailability(
    selection: ProposedF1SyntheticSelection,
  ): Promise<ProposedF1Availability> {
    checkSelection(selection);
    const url = new URL(
      root + "/locations/" + selection.locationId + "/availability",
    );
    url.searchParams.set("serviceId", selection.serviceId);
    url.searchParams.set("staffId", selection.staffId);
    url.searchParams.set("date", selection.localDate);

    const raw = await transport.request(url, { method: "GET", headers });
    const result = parseProposedF1Availability(raw);
    if (!result) throw new TransportFailure("invalid-response", 200);
    return result;
  }

  return {
    port: {
      async create(selection, idempotencyKey) {
        checkSelection(selection);
        if (!ATTEMPT_KEY.test(idempotencyKey)) {
          throw new Error("Invalid synthetic attempt key");
        }
        return transport.request(root + "/bookings", {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            customerId: config.syntheticCustomerId,
            locationId: selection.locationId,
            staffId: selection.staffId,
            serviceId: selection.serviceId,
            startAt: selection.startAt,
          }),
        });
      },
      verifyConfirmed: proposedF1ReceiptView,
      classifyConflict: classifyProposedF1Conflict,
      async refreshSlots(selection) {
        const latest = await readAvailability(selection);
        return latest.slots;
      },
    },
    readAvailability,
  };
}
