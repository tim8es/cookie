import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";

import { createTelegramOidcProvider } from "../src/telegram-oidc.js";

const CLIENT_ID = "123456789";
const REDIRECT_URI = "https://cookie.example/auth/telegram/callback";

function token(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = header + "." + payload;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKey,
  ).toString("base64url");
  return signingInput + "." + signature;
}

test("Telegram OIDC uses authorization code + PKCE and validates the signed identity", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: "test-key",
    use: "sig",
    alg: "RS256",
  };
  const nonce = "N".repeat(43);
  let tokenNonce = nonce;
  let tokenAudience: unknown = CLIENT_ID;
  const now = Math.floor(Date.now() / 1000);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth.telegram.org/.well-known/jwks.json") {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(url, "https://oauth.telegram.org/token");
    assert.equal(init?.method, "POST");
    assert.equal(
      new URLSearchParams(String(init?.body)).get("code_verifier"),
      "V".repeat(43),
    );
    return new Response(
      JSON.stringify({
        id_token: token(privateKey, {
          iss: "https://oauth.telegram.org",
          aud: tokenAudience,
          sub: "unique-subject-123",
          id: 987654321,
          nonce: tokenNonce,
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
      clientSecret: "synthetic-client-secret",
      redirectUri: REDIRECT_URI,
    },
    fetcher,
  );
  const authorization = new URL(
    provider.authorizationUrl({
      state: "S".repeat(43),
      nonce,
      codeChallenge: "C".repeat(43),
    }),
  );
  assert.equal(authorization.origin, "https://oauth.telegram.org");
  assert.equal(authorization.pathname, "/auth");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorization.searchParams.get("code_challenge"),
    "C".repeat(43),
  );
  assert.equal(authorization.searchParams.get("nonce"), nonce);
  assert.equal(authorization.searchParams.get("scope"), "openid profile");

  const identity = await provider.exchangeCode({
    code: "synthetic-code",
    codeVerifier: "V".repeat(43),
    nonce,
  });
  assert.deepEqual(identity, { telegramUserId: "987654321" });

  tokenNonce = "X".repeat(43);
  await assert.rejects(
    provider.exchangeCode({
      code: "synthetic-code",
      codeVerifier: "V".repeat(43),
      nonce,
    }),
    /Invalid Telegram OIDC identity claims/,
  );

  tokenNonce = nonce;
  tokenAudience = "another-client";
  await assert.rejects(
    provider.exchangeCode({
      code: "synthetic-code",
      codeVerifier: "V".repeat(43),
      nonce,
    }),
    /Invalid Telegram OIDC identity claims/,
  );
});

test("Telegram OIDC rejects non-HTTPS or non-callback redirect URIs", () => {
  assert.throws(
    () =>
      createTelegramOidcProvider({
        clientId: CLIENT_ID,
        clientSecret: "secret",
        redirectUri: "http://cookie.example/auth/telegram/callback",
      }),
    /Invalid Telegram OIDC configuration/,
  );
  assert.throws(
    () =>
      createTelegramOidcProvider({
        clientId: CLIENT_ID,
        clientSecret: "secret",
        redirectUri: "https://cookie.example/elsewhere",
      }),
    /Invalid Telegram OIDC configuration/,
  );
});
