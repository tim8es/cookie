import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultOwnerScreen,
  ownerRouteHref,
  ownerScreenFromPath,
  ownerScreenPath,
  screens,
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

test("owner routes map to screens", () => {
  assert.equal(ownerScreenPath("home"), "/overview");
  assert.equal(ownerScreenPath("calendar"), "/calendar");
  assert.equal(ownerScreenPath("services"), "/services");
  assert.equal(ownerScreenPath("staff"), "/staff");
  assert.equal(ownerScreenPath("schedule"), "/schedule");
  assert.equal(ownerScreenPath("locations"), "/locations");
  assert.equal(ownerScreenPath("appearance"), "/appearance");
  assert.equal(ownerScreenPath("booking"), "/booking");
  for (const { id } of screens) {
    assert.equal(ownerScreenFromPath(ownerScreenPath(id)), id);
    assert.equal(ownerScreenFromPath(ownerScreenPath(id) + "/"), id);
  }
  assert.equal(ownerScreenFromPath("/"), defaultOwnerScreen);
});

test("reserved paths are not owner screens", () => {
  assert.equal(ownerScreenFromPath("/v1/services"), null);
  assert.equal(ownerScreenFromPath("/assets/calendar"), null);
  assert.equal(ownerScreenFromPath("/demo"), null);
  assert.equal(ownerScreenFromPath("/unknown"), null);
  assert.equal(ownerScreenFromPath("//calendar"), null);
  assert.equal(ownerScreenFromPath("/%63alendar"), null);
  assert.equal(ownerScreenFromPath("/calendar/details"), null);
});

test("owner links preserve launch context", () => {
  const context = { search: "?lang=ru", hash: "#context" };
  const calendar = ownerRouteHref("calendar", context);
  assert.equal(calendar, "/calendar?lang=ru#context");
  const empty = { search: "", hash: "" };
  assert.equal(ownerRouteHref("services", empty), "/services");
});
