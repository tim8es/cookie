import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultOwnerScreen,
  ownerRouteHref,
  ownerScreenFromPath,
  ownerScreenPath,
  screens,
  isReservedPublicBookingPath,
} from "./navigation";

test("demo navigation contains unique screen targets for the owner and public flow", () => {
  const ids = screens.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("home"));
  assert.ok(ids.includes("calendar"));
  assert.ok(ids.includes("services"));
  assert.ok(ids.includes("staff"));
  assert.ok(ids.includes("schedule"));
  assert.ok(ids.includes("locations"));
  assert.ok(ids.includes("appearance"));
  assert.ok(ids.includes("booking"));
});

test("owner routes map only exact presentation paths", () => {
  for (const { id } of screens) {
    assert.equal(ownerScreenFromPath(ownerScreenPath(id)), id);
    assert.equal(ownerScreenFromPath(ownerScreenPath(id) + "/"), id);
  }
  assert.equal(ownerScreenPath("home"), "/overview");
  assert.equal(ownerScreenFromPath("/"), defaultOwnerScreen);
  for (const path of [
    "/v1/services",
    "/assets/calendar",
    "/demo",
    "/unknown",
    "//calendar",
    "/%63alendar",
    "/calendar/details",
  ]) {
    assert.equal(ownerScreenFromPath(path), null);
  }
});

test("owner routes preserve launch context without auth data", () => {
  assert.equal(
    ownerRouteHref("calendar", { search: "?lang=ru", hash: "#context" }),
    "/calendar?lang=ru#context",
  );
  assert.equal(
    ownerRouteHref("services", { search: "", hash: "" }),
    "/services",
  );
});

test("unpublished public booking entry stays isolated from owner route labels", () => {
  for (const path of [
    "/book",
    "/book/",
    "/book/salon-a",
    "/book/salon-a/location-1",
    "/book//unresolved",
  ]) {
    assert.equal(isReservedPublicBookingPath(path), true, path);
    assert.equal(ownerScreenFromPath(path), null, path);
  }
  for (const path of [
    "/",
    "/booking",
    "/bookings",
    "/bookcase",
    "/Book/salon-a",
    "/services",
    "/overview",
    "/demo",
  ]) {
    assert.equal(isReservedPublicBookingPath(path), false, path);
  }
});
