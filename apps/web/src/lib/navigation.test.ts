import assert from "node:assert/strict";
import { test } from "node:test";
import { screens } from "./navigation";

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
