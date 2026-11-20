import assert from "node:assert/strict";
import test from "node:test";

import { canonicalRegistrationEmail } from "../src/email-registration.js";

test("registration email canonicalizes DNS case without rewriting the mailbox", () => {
  assert.equal(
    canonicalRegistrationEmail("Some.One+tag@EXAMPLE.INVALID"),
    "Some.One+tag@example.invalid",
  );
  assert.notEqual(
    canonicalRegistrationEmail("Some.One+tag@example.invalid"),
    canonicalRegistrationEmail("some.one+tag@example.invalid"),
  );
});

test("unsupported and malformed registration emails fail closed", () => {
  for (const value of [
    null,
    12,
    "",
    " user@example.invalid",
    "user@example.invalid\n",
    "user@@example.invalid",
    ".user@example.invalid",
    "user..name@example.invalid",
    "user.@example.invalid",
    "user@-example.invalid",
    "user@example-.invalid",
    "user@example",
    "user@foo..invalid",
    "юзер@example.invalid",
    "a".repeat(65) + "@example.invalid",
  ]) {
    assert.equal(canonicalRegistrationEmail(value), null);
  }
});
