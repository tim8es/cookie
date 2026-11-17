import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/identity-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { telegramUserFingerprint } from "../../../packages/platform-identity/src/telegram-links.js";
import { exchangeSelfServiceTelegram } from "../../../packages/platform-identity/src/telegram-self-registration.js";

test(
  "verified Telegram self-registration is atomic, one-time and tenant independent",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
    const bot = "123456789:synthetic_NOT_A_REAL_BOT_TOKEN";
    const secret = Buffer.alloc(32, 35);
    const user = randomInt(100000000, 999999999);
    const fingerprint = telegramUserFingerprint(secret, String(user));
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: bot,
      maxAgeSeconds: 300,
    });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const proof = () => {
      const data = {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: randomUUID(),
        user: JSON.stringify({ id: user }),
      };
      const check = Object.entries(data)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      const key = createHmac("sha256", "WebAppData").update(bot).digest();
      return new URLSearchParams({
        ...data,
        hash: createHmac("sha256", key).update(check).digest("hex"),
      }).toString();
    };
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      assert.equal(
        await exchangeSelfServiceTelegram(
          transaction,
          verifier,
          secret,
          proof(),
          false,
          900,
        ),
        null,
      );
      assert.equal(
        await exchangeSelfServiceTelegram(
          transaction,
          verifier,
          secret,
          "hash=bad",
          true,
          900,
        ),
        null,
      );
      const signed = proof();
      const attempts = await Promise.all(
        [1, 2].map(() =>
          exchangeSelfServiceTelegram(
            transaction,
            verifier,
            secret,
            signed,
            true,
            900,
          ),
        ),
      );
      const issued = attempts.filter((x) => x !== null);
      assert.equal(issued.length, 1);
      const sessions = new IdentitySessions(
        pool,
        "cookie-telegram",
        "cookie-web",
        900,
      );
      const id = await sessions.resolve(issued[0]!.token);
      assert.ok(id);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.memberships WHERE identity_id=$1::uuid",
            [id],
          )
        ).rowCount,
        0,
      );
      const again = await exchangeSelfServiceTelegram(
        transaction,
        verifier,
        secret,
        proof(),
        false,
        900,
      );
      assert.ok(again);
      assert.equal(await sessions.resolve(again.token), id);
      assert.equal(
        (
          await pool.query(
            "SELECT identity_id FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1",
            [fingerprint],
          )
        ).rowCount,
        1,
      );
    } finally {
      const rows = await pool.query<{ identity_id: string }>(
        "SELECT identity_id::text FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1",
        [fingerprint],
      );
      const id = rows.rows[0]?.identity_id;
      if (id) {
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_exchanges WHERE identity_id=$1::uuid",
          [id],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
          [id],
        );
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_identities WHERE identity_id=$1::uuid",
          [id],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [id],
        );
      }
      await pool.end();
    }
  },
);
