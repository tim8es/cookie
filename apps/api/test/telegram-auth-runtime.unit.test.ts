import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import type { Pool } from "pg";

import { createLiveTelegramIdentityAuth } from "../src/telegram-auth-runtime.js";
import { registerTelegramIdentityAuth } from "../src/telegram-identity-auth-http.js";

const pool = {} as Pool;
const enabledSelfRegistration = {
  COOKIE_TELEGRAM_SELF_REGISTRATION_MODE: "enabled",
  COOKIE_TELEGRAM_USER_HMAC_SECRET: "a".repeat(64),
  COOKIE_TELEGRAM_BOT_TOKEN: "123456789:synthetic_NOT_A_REAL_BOT_TOKEN",
  COOKIE_PUBLIC_ORIGIN: "https://cookie-stage.example",
};

test("global Telegram self-registration has its own disabled-by-default gate", async () => {
  assert.equal(
    createLiveTelegramIdentityAuth(
      { COOKIE_TELEGRAM_AUTH_MODE: "enabled" },
      pool,
    ),
    null,
  );
  assert.throws(
    () =>
      createLiveTelegramIdentityAuth(
        { COOKIE_TELEGRAM_SELF_REGISTRATION_MODE: "yes" },
        pool,
      ),
    /COOKIE_TELEGRAM_SELF_REGISTRATION_MODE/,
  );

  const auth = createLiveTelegramIdentityAuth(enabledSelfRegistration, pool);
  assert.ok(auth);
  assert.equal(auth.pool, pool);
  assert.equal(auth.ttlSeconds, 900);

  const app = Fastify();
  registerTelegramIdentityAuth(app, auth);
  try {
    const invalidLink = await app.inject({
      method: "POST",
      url: "/v1/auth/telegram/link",
      headers: { authorization: `Bearer is_${"a".repeat(43)}` },
      payload: { initData: "invalid" },
    });
    assert.equal(invalidLink.statusCode, 401);
    assert.equal(invalidLink.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});
