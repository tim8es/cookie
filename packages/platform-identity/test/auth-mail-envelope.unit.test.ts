import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { createAuthMailEnvelope } from "../src/auth-mail-envelope.js";

test("mail envelope authenticates recipient and job metadata", () => {
  const key = randomBytes(32);
  const envelope = createAuthMailEnvelope(key);
  const id = randomUUID();
  const address = "synthetic@example.invalid";
  const purpose = "registration";
  const sealed = envelope.seal(id, purpose, address);
  assert.equal(envelope.open(id, purpose, sealed), address);
  assert.notDeepEqual(envelope.seal(id, purpose, address), sealed);
  assert.equal(sealed.includes(Buffer.from(address)), false);
  assert.throws(() => envelope.open(randomUUID(), purpose, sealed));
  assert.throws(() => envelope.open(id, "password-recovery", sealed));
  const wrongKey = createAuthMailEnvelope(randomBytes(32));
  assert.throws(() => wrongKey.open(id, purpose, sealed));
  const corrupted = Buffer.from(sealed);
  corrupted[20] = corrupted[20]! ^ 1;
  assert.throws(() => envelope.open(id, purpose, corrupted));
  assert.throws(() => createAuthMailEnvelope(Buffer.alloc(31)));
});
