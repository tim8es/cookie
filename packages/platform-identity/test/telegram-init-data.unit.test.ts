import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createTelegramMiniAppProofVerifier } from "../src/telegram-init-data.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const NOW = 1_794_830_400;
const USER = '{"id":4503599627370495,"first_name":"Тест"}';

// Fixed synthetic Telegram WebAppData vector: no live bot secret or real PII.
const VALID =
  "query_id=synthetic-query&user=%7B%22id%22%3A4503599627370495" +
  "%2C%22first_name%22%3A%22%D0%A2%D0%B5%D1%81%D1%82%22%7D" +
  "&auth_date=1794830400" +
  "&hash=cabc13dbb75f226ec478fdcb3d0f93069481490dac890f9b761918d7b4bb821b";

function verifier(now = NOW, botToken = BOT) {
  return createTelegramMiniAppProofVerifier({
    botToken,
    maxAgeSeconds: 600,
    maxFutureSkewSeconds: 30,
    nowUnixSeconds: () => now,
  });
}

function signed(fields: Record<string, string>, token = BOT): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&") +
    "&hash=" +
    hash
  );
}

test("known-good UTF-8 HMAC returns only minimal Telegram channel proof", () => {
  const proof = {
    channel: "telegram-mini-app",
    telegramUserId: "4503599627370495",
    authDateUnixSeconds: NOW,
  };
  assert.deepEqual(verifier().verify(VALID), proof);
  assert.deepEqual(
    verifier().verify(signed({ user: USER, auth_date: String(NOW) })),
    proof,
  );
});

test("unsigned identity, wrong bot, forged query or duplicate keys fail closed", () => {
  for (const raw of [
    VALID.replace("4503599627370495", "4503599627370494"),
    VALID.replace("synthetic-query", "forged-query"),
    VALID.replace("auth_date=1794830400", "auth_date=1794830401"),
    VALID.replace(/hash=[0-9a-f]+/, "hash=" + "f".repeat(64)),
    VALID + "&tenant_id=attacker",
    VALID + "&user=%7B%22id%22%3A1%7D",
    VALID + "&%75ser=%7B%22id%22%3A1%7D",
    VALID + "&hash=" + "0".repeat(64),
  ]) {
    assert.equal(verifier().verify(raw), null);
  }
  assert.equal(
    verifier(NOW, "987654321:another_synthetic_fake_bot_token").verify(VALID),
    null,
  );
});

test("bot-owner HMAC authenticates optional signature field without trusting it as a Cookie credential", () => {
  const fields = {
    auth_date: String(NOW),
    user: '{"id":279058397,"first_name":"Пример"}',
    query_id: "q+space and = symbols",
    signature: "synthetic-ed25519-metadata",
  };
  const withSignature = signed(fields);
  assert.deepEqual(verifier().verify(withSignature), {
    channel: "telegram-mini-app",
    telegramUserId: "279058397",
    authDateUnixSeconds: NOW,
  });
  // A tampered signature must not inherit the valid HMAC of other fields.
  assert.equal(
    verifier().verify(withSignature.replace("synthetic-ed25519-metadata", "forged-metadata")),
    null,
  );
  assert.equal(
    verifier().verify(withSignature.replace("q%2Bspace", "other")),
    null,
  );
  // Telegram's bot HMAC includes signature; appending it to an older
  // otherwise-valid payload without computing a new hash must be rejected.
  const withoutSignature = signed({
    auth_date: fields.auth_date,
    user: fields.user,
    query_id: fields.query_id,
  });
  assert.equal(
    verifier().verify(
      withoutSignature.replace("&hash=", "&signature=synthetic-ed25519-metadata&hash="),
    ),
    null,
  );
});

test("auth_date has bounded age and rejects future and invalid timestamps", () => {
  assert.ok(verifier(NOW + 600).verify(VALID));
  assert.equal(verifier(NOW + 601).verify(VALID), null);
  assert.ok(verifier(NOW - 30).verify(VALID));
  assert.equal(verifier(NOW - 31).verify(VALID), null);
  for (const auth_date of [
    "0",
    "-1",
    "1.25",
    "1e10",
    "NaN",
    "90071992547409999",
  ]) {
    assert.equal(verifier().verify(signed({ auth_date, user: USER })), null);
  }
  assert.equal(
    createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 600,
      nowUnixSeconds: () => Number.NaN,
    }).verify(VALID),
    null,
  );
});

test("malformed form data, duplicate decoded keys and oversized input are denied", () => {
  for (const raw of [
    "",
    null,
    undefined,
    17,
    "?" + VALID,
    VALID + "#fragment",
    VALID + "&",
    "user",
    "=" + VALID,
    VALID + "&foo",
    VALID + "&foo=%GG",
    VALID + "&foo=%FF",
    VALID + "&foo=%E0%A4%A",
    VALID + "&foo%0Abar=x",
    VALID + "&hash",
    VALID + "&auth_date=3",
    VALID + "&%68ash=other",
    VALID + "&user=OTHER",
    VALID + "&signature=a&signature=b",
    VALID + "&ignored=" + "x".repeat(9_000),
    VALID +
      "&" +
      Array.from({ length: 33 }, (_, i) => `extra_${i}=a`).join("&"),
  ]) {
    assert.equal(verifier().verify(raw), null, String(raw).slice(0, 80));
  }
});

test("even signed user field must be a JSON object with a safe positive ID", () => {
  for (const user of [
    "",
    "undefined",
    "null",
    "[]",
    "{}",
    '{"id":null}',
    '{"id":"279058397"}',
    '{"id":0}',
    '{"id":-1}',
    '{"id":1.5}',
    '{"id":9007199254740993}',
    '{"id":true}',
    '{"id":{}}',
  ]) {
    assert.equal(
      verifier().verify(signed({ user, auth_date: String(NOW) })),
      null,
      user,
    );
  }
  assert.equal(
    verifier().verify(
      signed({ auth_date: String(NOW), query_id: "chat-only" }),
    ),
    null,
  );
  const raw = signed({
    user: '{"id":999,"username":"not-an-identity","is_premium":true}',
    auth_date: String(NOW),
    tenant_id: "attacker",
    role: "owner",
  });
  assert.deepEqual(verifier().verify(raw), {
    channel: "telegram-mini-app",
    telegramUserId: "999",
    authDateUnixSeconds: NOW,
  });
});

test("refuses empty bot secrets and unbounded verifier time limits", () => {
  for (const config of [
    { botToken: "", maxAgeSeconds: 600 },
    { botToken: "not-a-bot-token", maxAgeSeconds: 600 },
    { botToken: BOT, maxAgeSeconds: 0 },
    { botToken: BOT, maxAgeSeconds: Number.POSITIVE_INFINITY },
    { botToken: BOT, maxAgeSeconds: 3_601 },
    { botToken: BOT, maxAgeSeconds: 600, maxFutureSkewSeconds: 61 },
    { botToken: BOT, maxAgeSeconds: 600, maxFutureSkewSeconds: -1 },
  ]) {
    assert.throws(() => createTelegramMiniAppProofVerifier(config));
  }
});
