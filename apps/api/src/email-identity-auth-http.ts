import { createHmac } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  AuthMailPurpose,
  EmailLoginResult,
  IdentitySessions,
} from "../../../packages/platform-identity/src/index.js";

export interface EmailIdentityAuthDependencies {
  readonly sourceFingerprintSecret: Buffer;
  readonly enqueueMail: (
    purpose: AuthMailPurpose,
    email: unknown,
    sourceFingerprint: Buffer,
  ) => Promise<void>;
  readonly completeRegistration: (
    token: unknown,
    password: unknown,
    sourceFingerprint: Buffer,
  ) => Promise<string | null>;
  readonly login: (
    email: unknown,
    password: unknown,
    sourceFingerprint: Buffer,
  ) => Promise<EmailLoginResult>;
  readonly completePasswordRecovery: (
    token: unknown,
    password: unknown,
    sourceFingerprint: Buffer,
  ) => Promise<boolean>;
  readonly identitySessionProviders?: readonly IdentitySessions[];
  readonly enqueueEmailLink?: (
    identityId: string,
    email: unknown,
    sourceFingerprint: Buffer,
  ) => Promise<void>;
  readonly completeEmailLink?: (
    token: unknown,
    password: unknown,
    identityToken: string,
    providers: readonly IdentitySessions[],
    sourceFingerprint: Buffer,
  ) => Promise<boolean>;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function validProof(
  value: unknown,
  prefix: "er" | "ep" | "el",
): value is string {
  return (
    typeof value === "string" &&
    value.length === 46 &&
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value)
  );
}

function validNewPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [...value].length >= 15 &&
    Buffer.byteLength(value, "utf8") <= 1024 &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

function sourceFingerprint(secret: Buffer, source: string): Buffer {
  return createHmac("sha256", secret)
    .update("cookie-auth-source-v1\0", "utf8")
    .update(source, "utf8")
    .digest();
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

/** Email credential routes. They issue only pre-tenant Identity sessions. */
export function registerEmailIdentityAuth(
  app: FastifyInstance,
  dependencies: EmailIdentityAuthDependencies,
): void {
  if (
    !Buffer.isBuffer(dependencies.sourceFingerprintSecret) ||
    dependencies.sourceFingerprintSecret.length < 32
  ) {
    throw new Error("Invalid email authentication source key");
  }
  const sourceKey = Buffer.from(dependencies.sourceFingerprintSecret);

  app.post("/v1/auth/email/registration/request", async (request, reply) => {
    noStore(reply);
    if (!exactObject(request.body, ["email"]))
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      await dependencies.enqueueMail(
        "registration",
        request.body.email,
        sourceFingerprint(sourceKey, request.ip),
      );
      return reply.code(202).send({ accepted: true });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });

  app.post("/v1/auth/email/registration/complete", async (request, reply) => {
    noStore(reply);
    if (
      !exactObject(request.body, ["token", "password"]) ||
      !validProof(request.body.token, "er") ||
      !validNewPassword(request.body.password)
    ) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    try {
      const identityId = await dependencies.completeRegistration(
        request.body.token,
        request.body.password,
        sourceFingerprint(sourceKey, request.ip),
      );
      return identityId
        ? reply.code(201).send({ registered: true })
        : reply.code(400).send({ error: "INVALID_OR_EXPIRED_PROOF" });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });

  app.post("/v1/auth/email/login", async (request, reply) => {
    noStore(reply);
    if (
      !exactObject(request.body, ["email", "password"]) ||
      typeof request.body.email !== "string" ||
      request.body.email.length > 254 ||
      typeof request.body.password !== "string" ||
      Buffer.byteLength(request.body.password, "utf8") > 1024
    ) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    try {
      const result = await dependencies.login(
        request.body.email,
        request.body.password,
        sourceFingerprint(sourceKey, request.ip),
      );
      if (result.status !== "authenticated")
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return reply.code(200).send({
        tokenType: "Bearer",
        accessToken: result.token,
        scope: "identity",
        expiresAtUnixSeconds: result.expiresAtUnixSeconds,
      });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });

  app.post(
    "/v1/auth/email/password-recovery/request",
    async (request, reply) => {
      noStore(reply);
      if (!exactObject(request.body, ["email"]))
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      try {
        await dependencies.enqueueMail(
          "password-recovery",
          request.body.email,
          sourceFingerprint(sourceKey, request.ip),
        );
        return reply.code(202).send({ accepted: true });
      } catch {
        return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
      }
    },
  );

  app.post(
    "/v1/auth/email/password-recovery/complete",
    async (request, reply) => {
      noStore(reply);
      if (
        !exactObject(request.body, ["token", "password"]) ||
        !validProof(request.body.token, "ep") ||
        !validNewPassword(request.body.password)
      ) {
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      }
      try {
        return (await dependencies.completePasswordRecovery(
          request.body.token,
          request.body.password,
          sourceFingerprint(sourceKey, request.ip),
        ))
          ? reply.code(204).send()
          : reply.code(400).send({ error: "INVALID_OR_EXPIRED_PROOF" });
      } catch {
        return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
      }
    },
  );

  app.post("/v1/auth/email/link/request", async (request, reply) => {
    noStore(reply);
    reply.header("Vary", "Authorization");
    const bearer = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!bearer) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    if (!exactObject(request.body, ["email"]))
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    const providers = dependencies.identitySessionProviders ?? [];
    if (!dependencies.enqueueEmailLink || providers.length === 0)
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    try {
      let identityId: string | null = null;
      for (const provider of providers) {
        identityId = await provider.resolve(bearer);
        if (identityId) break;
      }
      if (!identityId)
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      await dependencies.enqueueEmailLink(
        identityId,
        request.body.email,
        sourceFingerprint(sourceKey, request.ip),
      );
      return reply.code(202).send({ accepted: true });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });

  app.post("/v1/auth/email/link/complete", async (request, reply) => {
    noStore(reply);
    reply.header("Vary", "Authorization");
    const bearer = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!bearer) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    if (
      !exactObject(request.body, ["token", "password"]) ||
      !validProof(request.body.token, "el") ||
      !validNewPassword(request.body.password)
    ) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const providers = dependencies.identitySessionProviders ?? [];
    if (!dependencies.completeEmailLink || providers.length === 0)
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    try {
      const linked = await dependencies.completeEmailLink(
        request.body.token,
        request.body.password,
        bearer,
        providers,
        sourceFingerprint(sourceKey, request.ip),
      );
      return linked
        ? reply.code(204).send()
        : reply.code(400).send({ error: "INVALID_OR_EXPIRED_PROOF" });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}
