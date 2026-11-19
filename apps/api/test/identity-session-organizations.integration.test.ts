import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";

test(
  "identity organizations lookup does not deadlock on a saturated one-connection pool",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    const identityId = randomUUID();
    const sessions = new IdentitySessions(
      pool,
      "organization-test",
      "web",
      900,
    );
    const app = createApp(pool, {
      identitySessionProviders: [sessions],
      identitySessionPool: pool,
    });

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      const session = await sessions.issueForVerifiedIdentity(identityId);
      const lookups = await Promise.all(
        Array.from({ length: 8 }, () =>
          app.inject({
            method: "GET",
            url: "/v1/auth/identity/organizations",
            headers: { authorization: `Bearer ${session.token}` },
          }),
        ),
      );

      for (const response of lookups) {
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { organizations: [] });
      }
    } finally {
      await app.close();
      await pool.query(
        "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
        [identityId],
      );
      await pool.end();
    }
  },
);
