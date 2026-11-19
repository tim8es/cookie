import type {
  IdentitySessions,
  PostgresOpaqueTelegramSessions,
} from "../../../packages/platform-identity/src/index.js";
import type { BearerSessionVerifier } from "./session-context.js";

const TENANT_BEARER = /^cs_[A-Za-z0-9_-]{43}$/;
const IDENTITY_BEARER = /^is_[A-Za-z0-9_-]{43}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve legacy tenant sessions or global Identity sessions for a tenant path. */
export function createTenantSessionVerifier(
  legacy: PostgresOpaqueTelegramSessions | null,
  identities: readonly IdentitySessions[],
): BearerSessionVerifier | null {
  if (!legacy && identities.length === 0) return null;
  return {
    async verifyBearerToken(token, requestedTenantId) {
      if (TENANT_BEARER.test(token)) {
        return legacy ? legacy.verifyBearerToken(token) : null;
      }
      if (
        !IDENTITY_BEARER.test(token) ||
        !requestedTenantId ||
        !UUID.test(requestedTenantId)
      ) {
        return null;
      }
      for (const provider of identities) {
        const session = await provider.verifyBearerTokenForTenant(
          token,
          requestedTenantId,
        );
        if (session) return session;
      }
      return null;
    },
  };
}
