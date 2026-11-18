import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { Pool } from "pg";

import { createApp } from "../src/app.js";

interface HandlerResponse {
  headers: Record<string, { schema: { const: string } }>;
  content: {
    "application/json": {
      schema: { properties: { error: { enum: string[] } } };
    };
  };
}
interface Operation {
  operationId: string;
  responses: Record<string, HandlerResponse>;
}
const spec = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "packages/contracts/openapi/f1-staging-customer-v1.json",
    ),
    "utf8",
  ),
) as { paths: Record<string, Partial<Record<"get" | "post", Operation>>> };

const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const identity = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const booking = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const bearer = "cs_" + "a".repeat(43);
const authorization = "Bearer " + bearer;
const key = "contract-test-key-001";
const prefix = "/v1/organizations/{tenantId}/";
const uuidFields = {
  locationId: booking,
  staffId: booking,
  serviceId: booking,
};

const cases = [
  { route: "staging-customer-offers", method: "GET", group: "read" },
  { route: "staging-customer-slots", method: "GET", group: "read" },
  {
    route: "staging-customer-bookings/capability",
    method: "GET",
    group: "create",
  },
  { route: "staging-customer-bookings", method: "POST", group: "create" },
  {
    route: "staging-customer-bookings/receipt",
    method: "GET",
    group: "create",
  },
  { route: "staging-customer-history", method: "GET", group: "read" },
  {
    route: "staging-customer-cancellation/capability",
    method: "GET",
    group: "cancel",
  },
  {
    route: "staging-customer-cancellation/{bookingId}",
    method: "POST",
    group: "cancel",
  },
] as const;

type RouteCase = (typeof cases)[number];

function operation(item: RouteCase): Operation {
  const op = spec.paths[prefix + item.route]?.[
    item.method === "GET" ? "get" : "post"
  ];
  assert.ok(op);
  return op;
}

function url(item: RouteCase, tenantId = tenant): string {
  const path = (prefix + item.route)
    .replace("{tenantId}", tenantId)
    .replace("{bookingId}", booking);
  if (item.route !== "staging-customer-slots") return path;
  const query = new URLSearchParams({ ...uuidFields, localDate: "2027-05-01" });
  return path + "?" + query.toString();
}

function payload(item: RouteCase): object | undefined {
  if (item.method === "GET") return undefined;
  return item.group === "create"
    ? { ...uuidFields, startAt: "2027-05-01T10:00:00.000Z" }
    : {};
}

test("documented customer Booking routes are opt-in and fail closed", async () => {
  let databaseCalls = 0;
  const pool = {
    async connect() {
      databaseCalls++;
      throw new Error("private-test-database-error");
    },
    async query() {
      databaseCalls++;
      throw new Error("private-test-database-error");
    },
  } as unknown as Pool;
  const verifier = {
    async verifyBearerToken(token: string) {
      if (token !== bearer) return null;
      return {
        identityId: identity,
        tenantId: tenant,
        expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 60,
        opaqueSessionAuthority: {
          tokenSha256: createHash("sha256").update(bearer).digest("hex"),
          issuer: "test",
          audience: "test",
        },
      };
    },
  };
  const dependencies = { pool, verifier, enabled: true };
  const app = createApp(pool, {
    stagingPublicationRoutes: dependencies,
    stagingCustomerBookingRoutes: dependencies,
    stagingCustomerCancellationRoutes: { ...dependencies, cutoffMinutes: 0 },
  });
  const disabled = createApp(pool);
  try {
    assert.deepEqual(
      Object.keys(spec.paths).sort(),
      cases.map((item) => prefix + item.route).sort(),
    );
    for (const item of cases) {
      const op = operation(item);
      const input = {
        method: item.method,
        url: url(item),
        payload: payload(item),
      };
      const unmounted = await disabled.inject(input);
      assert.equal(unmounted.statusCode, 404, op.operationId);
      const check = async (
        status: number,
        error: string,
        response: {
          statusCode: number;
          headers: Record<string, unknown>;
          json(): unknown;
        },
      ) => {
        assert.equal(response.statusCode, status, op.operationId);
        const contract = op.responses[String(status)];
        assert.ok(contract);
        assert.ok(
          contract.content["application/json"].schema.properties.error.enum.includes(
            error,
          ),
        );
        assert.deepEqual(response.json(), { error });
        for (const [name, header] of Object.entries(contract.headers)) {
          assert.equal(
            response.headers[name.toLowerCase()],
            header.schema.const,
          );
        }
      };
      await check(401, "unauthorized", await app.inject(input));
      await check(
        403,
        "forbidden",
        await app.inject({
          ...input,
          url: url(item, foreign),
          headers: { authorization, "idempotency-key": key },
        }),
      );
      const hasInvalidRequest = Object.hasOwn(op.responses, "400");
      if (hasInvalidRequest) {
        const invalid = await app.inject({
          ...input,
          url:
            input.url + (input.url.includes("?") ? "&" : "?") + "unexpected=1",
          headers: { authorization, "idempotency-key": key },
        });
        await check(400, "invalid-request", invalid);
      }
      const before = databaseCalls;
      await check(
        503,
        "unavailable",
        await app.inject({
          ...input,
          headers: { authorization, "idempotency-key": key },
        }),
      );
      assert.ok(databaseCalls > before, op.operationId);
    }
  } finally {
    await app.close();
    await disabled.close();
  }
});
