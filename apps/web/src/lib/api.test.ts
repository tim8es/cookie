import assert from "node:assert/strict";
import { test } from "node:test";
import { createCookieUiApi, resolveCookieDataMode } from "./api";
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

test("disconnected API mode cannot call the network from any UI operation", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("External network call was not allowed");
  };

  try {
    const api = createCookieUiApi("api");
    const syntheticSchedule = {
      staffId: "synthetic-staff",
      locationId: "synthetic-location",
      weekdays: [1],
      startsAt: "09:00",
      endsAt: "18:00",
    };
    const operations = [
      () => api.getSnapshot(),
      () => api.createOrganization("Synthetic salon"),
      () => api.saveAppearance({ theme: "forest", introduction: "Демо" }),
      () => api.addLocation("Synthetic location", "Synthetic address"),
      () => api.addService("Synthetic service", 30, 1250),
      () => api.addStaff("Synthetic stylist", "Stylist", ["synthetic-service"]),
      () => api.saveSchedule(syntheticSchedule),
      () =>
        api.getSlotSuggestions(
          "synthetic-staff",
          "synthetic-location",
          "2026-11-16",
        ),
      () =>
        api.createBooking({
          locationId: "synthetic-location",
          serviceId: "synthetic-service",
          staffId: "synthetic-staff",
          date: "2026-11-16",
          time: "10:00",
          clientAlias: "Synthetic guest",
        }),
      () => api.resetDemo(),
    ];
    const notConnected = (reason: unknown): boolean =>
      reason instanceof UiFailure && reason.code === "NOT_CONNECTED";

    for (const operation of operations) {
      await assert.rejects(operation, notConnected);
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only the explicit demo route opts in; root and other paths use API", () => {
  for (const path of [
    "/",
    "/booking",
    "/demo-admin",
    "/demo/example",
    "/DEMO",
    "",
  ]) {
    assert.equal(resolveCookieDataMode(path), "api");
  }
  assert.equal(resolveCookieDataMode("/demo"), "mock");
  assert.equal(resolveCookieDataMode("/demo/"), "mock");
  assert.equal(createCookieUiApi().mode, "api");
});
