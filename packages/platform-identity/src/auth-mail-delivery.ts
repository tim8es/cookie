import { canonicalRegistrationEmail } from "./email-registration.js";

export type AuthMailPurpose =
  | "registration"
  | "password-recovery"
  | "email-link";

export interface AuthMailMessage {
  readonly recipient: string;
  readonly purpose: AuthMailPurpose;
  readonly confirmationUrl: string;
}

export interface AuthMailTransport {
  deliver(message: AuthMailMessage): Promise<void>;
}

export interface AuthMailLinkConfig {
  readonly publicOrigin: string;
  readonly registrationPath: string;
  readonly recoveryPath: string;
  readonly emailLinkPath?: string;
}

function configuredOrigin(input: string): URL {
  const origin = new URL(input);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("Invalid authentication mail origin");
  }
  return origin;
}

function configuredPath(input: string, origin: URL): string {
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(input) || input.startsWith("//")) {
    throw new Error("Invalid authentication mail path");
  }
  const resolved = new URL(input, origin);
  if (resolved.origin !== origin.origin || resolved.pathname !== input) {
    throw new Error("Invalid authentication mail path");
  }
  return resolved.pathname;
}

/**
 * Use deployment-owned URLs, never the request Host or a caller redirect.
 * Keep bearer proof out of the HTTP URL query, access log and referrer.
 * The matching frontend must remove the fragment and POST a proof only
 * after explicit user action. Nothing is consumed by following the link.
 */
export function createAuthMailDelivery(
  config: AuthMailLinkConfig,
  transport: AuthMailTransport,
): {
  send(
    purpose: AuthMailPurpose,
    challenge: { readonly address: string; readonly token: string },
  ): Promise<void>;
} {
  const origin = configuredOrigin(config.publicOrigin);
  const registration = configuredPath(config.registrationPath, origin);
  const recovery = configuredPath(config.recoveryPath, origin);
  const emailLink = config.emailLinkPath
    ? configuredPath(config.emailLinkPath, origin)
    : undefined;
  if (
    registration === recovery ||
    (emailLink !== undefined &&
      (emailLink === registration || emailLink === recovery))
  ) {
    throw new Error("Authentication mail paths must be distinct");
  }
  return {
    async send(purpose, challenge) {
      const recipient = canonicalRegistrationEmail(challenge.address);
      if (!recipient || recipient !== challenge.address) {
        throw new Error("Invalid authentication mail recipient");
      }
      const register = purpose === "registration";
      const isRecovery = purpose === "password-recovery";
      const linking = purpose === "email-link";
      if (!register && !isRecovery && !linking) {
        throw new Error("Invalid authentication mail purpose");
      }
      const pattern = register
        ? /^er_[A-Za-z0-9_-]{43}$/
        : isRecovery
          ? /^ep_[A-Za-z0-9_-]{43}$/
          : /^el_[A-Za-z0-9_-]{43}$/;
      if (challenge.token.length !== 46 || !pattern.test(challenge.token)) {
        throw new Error("Invalid authentication mail proof");
      }
      const path = register ? registration : isRecovery ? recovery : emailLink;
      if (!path)
        throw new Error("Email credential link path is not configured");
      const link = new URL(path, origin);
      link.hash = new URLSearchParams({ token: challenge.token }).toString();
      // Do not issue challenges here. The issuing transaction must already
      // have committed. Never expose the transport or its errors to clients.
      await transport.deliver({
        recipient,
        purpose,
        confirmationUrl: link.href,
      });
    },
  };
}
