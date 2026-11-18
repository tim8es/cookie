import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  createTelegramOidcProvider,
  IdentitySessions,
} from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";

const ORIGIN = "https://cookie.example.invalid";
const REDIRECT = ORIGIN + "/auth/telegram/callback";
const CLIENT_ID = "123456789";

function signedIdToken(
  privateKey: KeyObject,
  claims: Record<string, unknown>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "integration-key" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = header + "." + body;
  const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString(
    "base64url",
  );
  return input + "." + signature;
}

test(
  "Telegram OIDC state is one-time and shares Identity mapping with account linking",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
    const stateCookieKey = randomBytes(32);
    const fingerprintSecret = randomBytes(32);
    const telegramSessions = new IdentitySessions(
      pool,
      "cookie-telegram",
      "cookie-web",
      900,
    );
    const emailSessions = new IdentitySessions(
      pool,
      "cookie-email",
      "cookie-web",
      900,
    );
    const providers = [telegramSessions, emailSessions];
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwk = {
      ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid: "integration-key",
      use: "sig",
      alg: "RS256",
    };
    let currentNonce = "";
    let currentTelegramId = "987654321";
    let now = Math.floor(Date.now() / 1000);
    const fetcher: typeof fetch = async (input, init) => {
      if (
        String(input) === "https://oauth.telegram.org/.well-known/jwks.json"
      ) {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(String(input), "https://oauth.telegram.org/token");
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("redirect_uri"), REDIRECT);
      assert.ok(init?.headers);
      const headers = new Headers(init.headers);
      assert.match(headers.get("authorization") ?? "", /^Basic /);
      return new Response(
        JSON.stringify({
          id_token: signedIdToken(privateKey, {
            iss: "https://oauth.telegram.org",
            aud: CLIENT_ID,
            sub: "synthetic-oidc-subject",
            id: currentTelegramId,
            nonce: currentNonce,
            iat: now,
            exp: now + 300,
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = createTelegramOidcProvider(
      {
        clientId: CLIENT_ID,
        clientSecret: "synthetic-secret",
        redirectUri: REDIRECT,
      },
      fetcher,
    );
    const sourceIp = "198.51.100.81";
    const sourceFingerprint = createHmac("sha256", stateCookieKey)
      .update("cookie-telegram-oidc-source-v1\0", "utf8")
      .update(sourceIp, "utf8")
      .digest();
    const startedAt = await pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const app = createApp(pool, {
      telegramOidcRoutes: {
        pool,
        provider,
        redirectUri: REDIRECT,
        fingerprintSecret,
        stateCookieKey,
        identitySessionProviders: providers,
        requestLimits: {
          windowSeconds: 900,
          accountAttempts: 20,
          sourceAttempts: 20,
        },
      },
      identitySessionProviders: providers,
      identitySessionPool: pool,
    });
    const identities = new Set<string>();
    t.after(async () => {
      await app.close();
      const created = await pool.query<{ id: string }>(
        "SELECT id::text FROM cookie_identity.identities WHERE created_at >= $1::timestamptz",
        [startedAt.rows[0]!.now],
      );
      const ids = [...identities, ...created.rows.map((row) => row.id)];
      if (ids.length > 0) {
        await pool.query(
          "DELETE FROM cookie_identity.auth_security_events WHERE identity_id=ANY($1::uuid[])",
          [ids],
        );
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_exchanges WHERE identity_id=ANY($1::uuid[])",
          [ids],
        );
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_identities WHERE identity_id=ANY($1::uuid[])",
          [ids],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=ANY($1::uuid[])",
          [ids],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [ids],
        );
      }
      await pool.query(
        "DELETE FROM cookie_identity.telegram_oidc_authorizations WHERE created_at >= $1::timestamptz",
        [startedAt.rows[0]!.now],
      );
      await pool.query(
        "DELETE FROM cookie_identity.email_login_attempts WHERE scope='source' AND subject_hmac_sha256=$1",
        [sourceFingerprint],
      );
      await pool.end();
    });

    await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
    const begin = async (
      intent: "login" | "register" | "link",
      identityToken?: string,
    ) => {
      const response = await app.inject({
        method: "POST",
        url:
          intent === "link"
            ? "/v1/auth/telegram/oidc/link/start"
            : "/v1/auth/telegram/oidc/start",
        headers: {
          origin: ORIGIN,
          ...(identityToken
            ? { authorization: `Bearer ${identityToken}` }
            : {}),
        },
        payload: intent === "link" ? {} : { intent },
        remoteAddress: sourceIp,
      });
      assert.equal(response.statusCode, 200);
      const authorizationUrl = new URL(response.json().authorizationUrl);
      const setCookie = response.headers["set-cookie"];
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = cookieHeader?.split(";", 1)[0];
      assert.ok(cookie);
      assert.ok(cookie.startsWith("cookie_tg_oidc="));
      currentNonce = authorizationUrl.searchParams.get("nonce") ?? "";
      now = Math.floor(Date.now() / 1000);
      return {
        cookie,
        state: authorizationUrl.searchParams.get("state")!,
        codeChallenge: authorizationUrl.searchParams.get("code_challenge")!,
      };
    };
    const complete = async (flow: { cookie: string; state: string }) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/telegram/oidc/complete",
        headers: {
          origin: ORIGIN,
          cookie: flow.cookie,
        },
        payload: { code: "synthetic-code", state: flow.state },
        remoteAddress: sourceIp,
      });

    const registration = await begin("register");
    assert.equal(registration.codeChallenge.length, 43);
    const firstLogin = await complete(registration);
    assert.equal(firstLogin.statusCode, 200);
    const firstToken = firstLogin.json().accessToken as string;
    const firstIdentity = await telegramSessions.resolve(firstToken);
    assert.ok(firstIdentity);
    identities.add(firstIdentity);
    assert.equal(await telegramSessions.resolve(firstToken), firstIdentity);

    const replayed = await complete(registration);
    assert.equal(replayed.statusCode, 401);

    const login = await begin("login");
    const secondLogin = await complete(login);
    assert.equal(secondLogin.statusCode, 200);
    assert.equal(
      await telegramSessions.resolve(secondLogin.json().accessToken),
      firstIdentity,
    );

    const emailIdentity = randomUUID();
    await pool.query(
      "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
      [emailIdentity],
    );
    identities.add(emailIdentity);
    const emailSession =
      await emailSessions.issueForVerifiedIdentity(emailIdentity);
    currentTelegramId = "123456789";
    const link = await begin("link", emailSession.token);
    const linked = await complete(link);
    assert.equal(linked.statusCode, 204);
    const mapping = await pool.query<{ identity_id: string }>(
      "SELECT identity_id::text FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1",
      [
        createHmac("sha256", fingerprintSecret)
          .update("cookie-telegram-user-fingerprint-v1\0", "utf8")
          .update(currentTelegramId, "utf8")
          .digest(),
      ],
    );
    assert.equal(mapping.rows[0]?.identity_id, emailIdentity);
    const linkedLogin = await begin("login");
    const linkedSession = await complete(linkedLogin);
    assert.equal(linkedSession.statusCode, 200);
    assert.equal(
      await telegramSessions.resolve(linkedSession.json().accessToken),
      emailIdentity,
    );
  },
);
