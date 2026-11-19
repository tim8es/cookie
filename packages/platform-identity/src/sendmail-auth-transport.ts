import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  AuthMailMessage,
  AuthMailTransport,
} from "./auth-mail-delivery.js";
import { canonicalRegistrationEmail } from "./email-registration.js";

export interface SendmailAuthMailConfig {
  readonly executable: string;
  readonly fromAddress: string;
  readonly timeoutMs: number;
}

function mailAddress(value: string): boolean {
  return canonicalRegistrationEmail(value) === value && !value.startsWith("-");
}

function encodeMessage(message: AuthMailMessage, from: string): string {
  if (!mailAddress(message.recipient)) {
    throw new Error("Invalid authentication mail recipient");
  }
  const link = new URL(message.confirmationUrl);
  const isRegistration = message.purpose === "registration";
  const isRecovery = message.purpose === "password-recovery";
  const isLink = message.purpose === "email-link";
  if (!isRegistration && !isRecovery && !isLink) {
    throw new Error("Invalid authentication mail purpose");
  }
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  const pattern = isRegistration
    ? /^er_[A-Za-z0-9_-]{43}$/
    : isRecovery
      ? /^ep_[A-Za-z0-9_-]{43}$/
      : /^el_[A-Za-z0-9_-]{43}$/;
  if (
    link.protocol !== "https:" ||
    link.username ||
    link.password ||
    link.search ||
    !token ||
    token.length !== 46 ||
    !pattern.test(token) ||
    link.hash !== "#token=" + token ||
    link.href !== message.confirmationUrl
  ) {
    throw new Error("Invalid authentication mail link");
  }
  const subject = isRegistration
    ? "Confirm your kuki email"
    : isRecovery
      ? "Reset your kuki password"
      : "Link your kuki email";
  const body = [
    subject,
    "",
    link.href,
    "",
    "If you did not request this, you can ignore this email.",
    "",
  ].join("\r\n");
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const lines = encoded.match(/.{1,76}/g) ?? [];
  return [
    "From: <" + from + ">",
    "To: <" + message.recipient + ">",
    "Subject: " + subject,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...lines,
    "",
  ].join("\r\n");
}

/**
 * Real local MTA submission through a configured sendmail-compatible binary.
 * No shell, no caller-controlled executable/arguments, no inherited app
 * secrets or provider stdout/stderr. Exit zero means accepted by local MTA,
 * not remote inbox receipt. On ambiguous failure do not blindly retry a
 * bearer proof. A later production queue needs its own delivery policy.
 */
export function createSendmailAuthTransport(
  config: SendmailAuthMailConfig,
): AuthMailTransport {
  const { executable, fromAddress, timeoutMs } = config;
  if (
    !isAbsolute(executable) ||
    executable.includes("\0") ||
    !mailAddress(fromAddress) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 30000
  ) {
    throw new Error("Invalid sendmail authentication configuration");
  }

  return {
    async deliver(message) {
      const input = encodeMessage(message, fromAddress);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ["-i", "-f", fromAddress, "-t"], {
          shell: false,
          stdio: ["pipe", "ignore", "ignore"],
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        });
        let failed = false;
        const timer = setTimeout(() => {
          failed = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.on("error", () => {
          failed = true;
        });
        child.stdin.on("error", () => {
          failed = true;
          child.kill("SIGKILL");
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (failed || code !== 0) {
            reject(new Error("Authentication mail submission failed"));
          } else {
            resolve();
          }
        });
        child.stdin.end(input, "utf8");
      });
    },
  };
}
