import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";

const databaseUrl = "postgres://cookie_dev:cookie_dev@127.0.0.1:5432/cookie_dev";

test("config accepts a local synthetic database and safe loopback default", () => {
  assert.deepEqual(parseConfig({ DATABASE_URL: databaseUrl }), {
    databaseUrl,
    host: "127.0.0.1",
    port: 3000,
  });
});

for (const port of ["0", "-1", "65536", "abc", "1.5", " 3000"]) {
  test(`config rejects invalid PORT ${JSON.stringify(port)}`, () => {
    assert.throws(() => parseConfig({ PORT: port, DATABASE_URL: databaseUrl }), /PORT/);
  });
}

test("config fails closed without database URL and does not disclose credentials", () => {
  assert.throws(() => parseConfig({}), /DATABASE_URL is required/);
  assert.throws(() => parseConfig({ DATABASE_URL: "https://example.com/db" }), /PostgreSQL URL/);
});
