import assert from "node:assert/strict";
import { test } from "node:test";
import { createCookieUiApi } from "./api";
import { UiFailure } from "./model";

test("API mode cannot invent requests or report a synthetic confirmation", async () => {
  const api = createCookieUiApi("api");
  assert.equal(api.mode, "api");
  const expectNotConnected = (error: unknown): boolean =>
    error instanceof UiFailure && error.code === "NOT_CONNECTED";
  await assert.rejects(() => api.getSnapshot(), expectNotConnected);
  await assert.rejects(
    () =>
      api.createBooking({
        locationId: "synthetic-location",
        serviceId: "synthetic-service",
        staffId: "synthetic-staff",
        date: "2026-11-16",
        time: "10:00",
        clientAlias: "Synthetic guest",
      }),
    expectNotConnected,
  );
});
