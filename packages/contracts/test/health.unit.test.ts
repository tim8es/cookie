import assert from "node:assert/strict";
import test from "node:test";

import { SERVICE_NAME } from "../src/index.js";

test("public contracts contain only infrastructure metadata", () => {
  assert.equal(SERVICE_NAME, "cookie-api");
});
