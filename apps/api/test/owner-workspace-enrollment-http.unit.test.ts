import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";

test("owner enrollment rejects client-supplied Identity and tenant claims", async (t) => {
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    {
      ownerWorkspaceEnrollment: {
        pool: {} as never,
        identitySessionProviders: [],
      },
    },
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/owner/workspace",
    headers: { "idempotency-key": "owner-setup-00000001" },
    payload: {
      ownerIdentityId: "00000000-0000-4000-8000-000000000001",
      tenantId: "00000000-0000-4000-8000-000000000002",
      organizationName: "Synthetic salon",
      locationName: "Synthetic location",
      timeZone: "Europe/Moscow",
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), { error: "INVALID_REQUEST" });
});
