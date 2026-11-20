import type {
  AuthMailMessage,
  AuthMailTransport,
} from "./auth-mail-delivery.js";
import { canonicalRegistrationEmail } from "./email-registration.js";

const SEND_URL = "https://console.altare.gg/api/email/v1/send";

export interface AltareEmailApiConfig {
  readonly apiToken: string;
  readonly fromAddress: string;
  readonly timeoutMs: number;
  readonly fetcher?: typeof fetch;
}

function messageText(message: AuthMailMessage): {
  subject: string;
  text: string;
} {
  const subject =
    message.purpose === "registration"
      ? "Cookie — подтвердите email"
      : message.purpose === "password-recovery"
        ? "Cookie — восстановление пароля"
        : message.purpose === "email-link"
          ? "Cookie — привязка email"
          : null;
  if (!subject) throw new Error("Invalid authentication mail purpose");
  const link = new URL(message.confirmationUrl);
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  const tokenPattern =
    message.purpose === "registration"
      ? /^er_[A-Za-z0-9_-]{43}$/
      : message.purpose === "password-recovery"
        ? /^ep_[A-Za-z0-9_-]{43}$/
        : /^el_[A-Za-z0-9_-]{43}$/;
  if (
    link.protocol !== "https:" ||
    link.username ||
    link.password ||
    link.search ||
    !token ||
    !tokenPattern.test(token) ||
    link.hash !== "#token=" + token ||
    link.href !== message.confirmationUrl
  ) {
    throw new Error("Invalid authentication mail link");
  }
  return {
    subject,
    text: `${subject}\n\nОткройте ссылку, чтобы продолжить:\n${link.href}\n\nЕсли вы не запрашивали это действие, проигнорируйте письмо.`,
  };
}

/** Submit one proof email through Altare's verified-domain email API. */
export function createAltareEmailApiTransport(
  config: AltareEmailApiConfig,
): AuthMailTransport {
  if (
    typeof config.apiToken !== "string" ||
    !/^aem_[A-Za-z0-9_-]+$/.test(config.apiToken) ||
    canonicalRegistrationEmail(config.fromAddress) !== config.fromAddress ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1000 ||
    config.timeoutMs > 30000
  ) {
    throw new Error("Invalid Altare email configuration");
  }
  const token = config.apiToken;
  const from = `Cookie <${config.fromAddress}>`;
  const fetcher = config.fetcher ?? globalThis.fetch;

  return {
    async deliver(message) {
      if (canonicalRegistrationEmail(message.recipient) !== message.recipient)
        throw new Error("Invalid authentication mail recipient");
      const mail = messageText(message);
      try {
        const response = await fetcher(SEND_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: message.recipient,
            subject: mail.subject,
            text: mail.text,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error("rejected");
        const result: unknown = await response.json();
        if (
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          !Array.isArray((result as { accepted?: unknown }).accepted) ||
          !Array.isArray((result as { rejected?: unknown }).rejected) ||
          !Array.isArray((result as { suppressed?: unknown }).suppressed) ||
          (result as { accepted: unknown[] }).accepted.length !== 1 ||
          (result as { accepted: unknown[] }).accepted[0] !==
            message.recipient ||
          (result as { rejected: unknown[] }).rejected.length !== 0 ||
          (result as { suppressed: unknown[] }).suppressed.length !== 0
        ) {
          throw new Error("unaccepted");
        }
      } catch {
        throw new Error("Authentication mail submission failed");
      }
    },
  };
}
