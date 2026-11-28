import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAuthMailDelivery,
  type AuthMailMessage,
} from "../src/auth-mail-delivery.js";
import { createSendmailAuthTransport } from "../src/sendmail-auth-transport.js";

const links = {
  publicOrigin: "https://kuki.example.invalid",
  registrationPath: "/auth/confirm",
  recoveryPath: "/auth/recover",
};
const recipient = "test@example.invalid";
const regToken = "er_" + "a".repeat(43);
const resetToken = "ep_" + "b".repeat(43);

test("auth links use trusted origin and purpose fragments", async () => {
  const sent: AuthMailMessage[] = [];
  const transport = {
    deliver: async (message: AuthMailMessage) => {
      sent.push(message);
    },
  };
  const delivery = createAuthMailDelivery(links, transport);
  await delivery.send("registration", {
    address: recipient,
    token: regToken,
  });
  await delivery.send("password-recovery", {
    address: recipient,
    token: resetToken,
  });
  assert.equal(sent.length, 2);
  assert.equal(
    sent[0]?.confirmationUrl,
    links.publicOrigin + links.registrationPath + "#token=" + regToken,
  );
  assert.equal(
    sent[1]?.confirmationUrl,
    links.publicOrigin + links.recoveryPath + "#token=" + resetToken,
  );
  await assert.rejects(
    delivery.send("password-recovery", {
      address: recipient,
      token: regToken,
    }),
  );
  await assert.rejects(
    delivery.send("registration", {
      address: "test@example.invalid\r\nBcc: attacker@example.invalid",
      token: regToken,
    }),
  );
  assert.equal(sent.length, 2);

  for (const publicOrigin of [
    "http://kuki.example.invalid",
    "https://user@kuki.example.invalid",
    "https://kuki.example.invalid/path",
    "https://kuki.example.invalid/?token=old",
  ]) {
    assert.throws(() =>
      createAuthMailDelivery({ ...links, publicOrigin }, transport),
    );
  }
  for (const registrationPath of [
    "//other.example.invalid/auth",
    "/auth/../recover",
    "/auth?next=other",
    links.recoveryPath,
  ]) {
    assert.throws(() =>
      createAuthMailDelivery({ ...links, registrationPath }, transport),
    );
  }
});

test(
  "sendmail submits MIME and sanitizes failures",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kuki-auth-mail-"));
    try {
      const executable = join(dir, "synthetic-sendmail");
      await writeFile(
        executable,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\ncat > "$0.message"\n',
        { mode: 0o700 },
      );
      const config = {
        executable,
        fromAddress: "auth@example.invalid",
        timeoutMs: 1000,
      };
      const transport = createSendmailAuthTransport(config);
      const delivery = createAuthMailDelivery(links, transport);
      await delivery.send("registration", {
        address: recipient,
        token: regToken,
      });
      assert.equal(
        await readFile(executable + ".args", "utf8"),
        "-i\n-f\nauth@example.invalid\n-t\n",
      );
      const message = await readFile(executable + ".message", "utf8");
      const [headers, encoded] = message.split("\r\n\r\n");
      assert.match(headers ?? "", /To: <test@example\.invalid>/);
      assert.match(headers ?? "", /Content-Transfer-Encoding: base64/);
      assert.doesNotMatch(headers ?? "", /er_/);
      const body = Buffer.from(encoded ?? "", "base64").toString("utf8");
      assert.ok(body.includes("#token=" + regToken));

      await writeFile(executable, "#!/bin/sh\ncat >/dev/null\nexit 7\n");
      await assert.rejects(
        delivery.send("registration", {
          address: recipient,
          token: regToken,
        }),
        /^Error: Authentication mail submission failed$/,
      );
      await writeFile(executable, "#!/bin/sh\nexec sleep 5\n");
      await assert.rejects(
        delivery.send("registration", {
          address: recipient,
          token: regToken,
        }),
        /^Error: Authentication mail submission failed$/,
      );
      assert.throws(() =>
        createSendmailAuthTransport({ ...config, executable: "sendmail" }),
      );
      assert.throws(() =>
        createSendmailAuthTransport({
          ...config,
          fromAddress: "-bad@example.invalid",
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sendmail timeout terminates ordinary POSIX descendants",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kuki-mail-group-"));
    try {
      const executable = join(dir, "synthetic-sendmail");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          "cat >/dev/null",
          "( sleep 2; printf late > \"$0.late\" ) &",
          "printf started > \"$0.started\"",
          "wait",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const delivery = createAuthMailDelivery(
        links,
        createSendmailAuthTransport({
          executable,
          fromAddress: "auth@example.invalid",
          timeoutMs: 1000,
        }),
      );
      await assert.rejects(
        delivery.send("registration", {
          address: recipient,
          token: regToken,
        }),
        /^Error: Authentication mail submission failed$/,
      );
      // Ensure the fixture actually entered the descendant-spawn path.
      const started = await readFile(executable + ".started", "utf8");
      assert.equal(started, "started");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await assert.rejects(readFile(executable + ".late"), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
