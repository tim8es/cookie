import assert from "node:assert/strict";
import test from "node:test";

import { createAltareEmailApiTransport } from "../src/altare-email-api-transport.js";
import {
  createAuthMailDelivery,
  type AuthMailMessage,
} from "../src/auth-mail-delivery.js";

const links = {
  publicOrigin: "https://cookie.example.invalid",
  registrationPath: "/register",
  recoveryPath: "/recover",
  emailLinkPath: "/link-email",
};
const config = {
  apiToken: "aem_test-secret-token",
  fromAddress: "auth@example.invalid",
  timeoutMs: 3000,
};
const proof = "er_" + "A".repeat(43);

test("Altare email API sends only the expected recipient and proof message", async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const transport = createAltareEmailApiTransport({
    ...config,
    fetcher: async (input, init) => {
      sent = { url: String(input), init: init ?? {} };
      return Response.json({
        id: "em_test",
        accepted: ["test@example.invalid"],
        rejected: [],
        suppressed: [],
      });
    },
  });
  await createAuthMailDelivery(links, transport).send("registration", {
    address: "test@example.invalid",
    token: proof,
  });

  assert.equal(sent?.url, "https://console.altare.gg/api/email/v1/send");
  assert.equal(
    new Headers(sent?.init.headers).get("authorization"),
    "Bearer " + config.apiToken,
  );
  assert.equal(sent?.init.credentials, "omit");
  const body = JSON.parse(String(sent?.init.body)) as {
    from: string;
    to: string;
    subject: string;
    text: string;
  };
  assert.equal(body.from, "Cookie <auth@example.invalid>");
  assert.equal(body.to, "test@example.invalid");
  assert.match(body.subject, /Cookie/);
  assert.ok(body.text.includes("#token=" + proof));
});

test("Altare email failures stay generic and unaccepted proofs are not retried", async () => {
  const messages: AuthMailMessage[] = [];
  const transport = createAltareEmailApiTransport({
    ...config,
    fetcher: async () =>
      Response.json(
        {
          accepted: [],
          rejected: [{ address: "test@example.invalid" }],
          suppressed: [],
        },
        { status: 422 },
      ),
  });
  const delivery = createAuthMailDelivery(links, {
    deliver: async (message) => {
      messages.push(message);
      await transport.deliver(message);
    },
  });
  await assert.rejects(
    delivery.send("registration", {
      address: "test@example.invalid",
      token: proof,
    }),
    /^Error: Authentication mail submission failed$/,
  );
  assert.equal(messages.length, 1);
});

test("Altare email API configuration rejects invalid tokens and senders", () => {
  assert.throws(
    () => createAltareEmailApiTransport({ ...config, apiToken: "not-a-token" }),
    /Invalid Altare email configuration/,
  );
  assert.throws(
    () =>
      createAltareEmailApiTransport({ ...config, fromAddress: "bad address" }),
    /Invalid Altare email configuration/,
  );
});
