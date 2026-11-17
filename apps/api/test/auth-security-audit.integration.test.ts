import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import {
  appendAuthIdentityAudit,
  purgeAuthSecurityEvents,
} from "../../../packages/platform-identity/src/auth-security-audit.js";

test(
  "auth audit is typed, transactional and subject to bounded retention",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const tx = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const old = randomUUID();
    const fresh = randomUUID();
    const rollback = randomUUID();
    const ids = [old, fresh, rollback];
    const read = () =>
      pool.query<{ identity_id: string }>(
        "SELECT identity_id::text FROM cookie_identity.auth_security_events WHERE identity_id=ANY($1::uuid[]) ORDER BY id",
        [ids],
      );

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await assert.rejects(
        tx(async (client) => {
          await appendAuthIdentityAudit(client, "email_registered", rollback);
          throw new Error("synthetic rollback");
        }),
        /synthetic rollback/,
      );
      assert.equal((await read()).rowCount, 0);
      await tx((client) => appendAuthIdentityAudit(client, "email_login", old));
      await tx((client) =>
        appendAuthIdentityAudit(client, "password_recovered", fresh),
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO cookie_identity.auth_security_events(event_type,identity_id) VALUES ('mail_submitted',$1::uuid)",
          [fresh],
        ),
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO cookie_identity.auth_security_events(event_type,identity_id) VALUES ('untrusted_payload',$1::uuid)",
          [fresh],
        ),
      );
      await pool.query(
        "UPDATE cookie_identity.auth_security_events SET occurred_at=clock_timestamp()-interval '2 hours' WHERE identity_id=$1",
        [old],
      );
      assert.ok(await purgeAuthSecurityEvents(tx, 1000, 3600));
      assert.deepEqual(
        (await read()).rows.map((row) => row.identity_id),
        [fresh],
      );
      await assert.rejects(purgeAuthSecurityEvents(tx, 0, 3600));
      await assert.rejects(purgeAuthSecurityEvents(tx, 100, 0));
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_identity.auth_security_events WHERE identity_id=ANY($1::uuid[])",
          [ids],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
