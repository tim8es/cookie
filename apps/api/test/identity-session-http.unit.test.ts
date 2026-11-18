import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";

test("identity provider state is private to an identity bearer", async (t) => {
  const provider = {} as IdentitySessions;
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    {
      identitySessionProviders: [provider],
      identitySessionPool: {} as Pool,
    },
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/identity/providers",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.vary, "Authorization");
});
