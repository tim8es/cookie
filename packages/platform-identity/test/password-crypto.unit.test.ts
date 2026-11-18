import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword } from "../src/password-crypto.js";

test("password storage uses distinct salts and verifies only the exact input", async () => {
  const password = " synthetic-Тест-🔑 ";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.notEqual(first.split("$")[1], second.split("$")[1]);
  assert.ok(await verifyPassword(password, first));
  assert.ok(await verifyPassword(password, second));
  assert.equal(await verifyPassword(password.trim(), first), false);
  assert.equal(await verifyPassword("different synthetic input", first), false);
});

test("malformed hashes and invalid password inputs fail closed", async () => {
  const salt = "a".repeat(32);
  const key = "b".repeat(64);
  const canonical = ["scrypt-v1", salt, key].join("$");
  const malformed = [
    null,
    42,
    "",
    canonical + "$",
    canonical.replace("scrypt-v1", "scrypt-v2"),
    canonical.replace("scrypt-v1", "N=9999999"),
    canonical.replace(salt, "A".repeat(32)),
    canonical.replace(salt, salt.slice(1) + "\n"),
    canonical.replace(key, key.slice(1) + "\n"),
    canonical.replace(key, "g" + key.slice(1)),
    canonical.slice(0, -1),
  ];
  for (const stored of malformed) {
    assert.equal(await verifyPassword("synthetic", stored), false);
  }
  for (const password of [
    null,
    42,
    "",
    "a".repeat(1025),
    "я".repeat(513),
    "\uD800",
  ]) {
    await assert.rejects(hashPassword(password), /Invalid password input/);
    assert.equal(await verifyPassword(password, canonical), false);
  }
});
