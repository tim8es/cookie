import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Schema {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  format?: string;
}

interface ResponseContract {
  headers: Record<string, { schema: Schema }>;
  content: { "application/json": { schema: Schema } };
}
const contractPath = "packages/contracts/openapi/f1-staging-customer-v1.json";
const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), contractPath), "utf8"),
) as {
  paths: Record<
    string,
    Record<string, { responses: Record<string, ResponseContract> }>
  >;
  components: { schemas: Record<string, Schema> };
};

const supported = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "maxItems",
  "minimum",
  "maximum",
  "enum",
  "const",
  "pattern",
  "format",
]);

/** Test-only assertions for the schema subset used by this exact contract.
 * Reject unknown keywords rather than silently accepting new constraints.
 * Not a general OpenAPI or JSON Schema validator.
 */
export function assertSchema(schema: Schema, value: unknown): void {
  for (const keyword of Object.keys(schema)) {
    assert.ok(supported.has(keyword), "Unsupported keyword: " + keyword);
  }
  if (schema.$ref) {
    const prefix = "#/components/schemas/";
    assert.ok(schema.$ref.startsWith(prefix));
    const target = spec.components.schemas[schema.$ref.slice(prefix.length)];
    assert.ok(target);
    assertSchema(target, value);
  }
  if (Object.hasOwn(schema, "const")) assert.equal(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    assert.ok(types.includes(actual), "Unexpected schema type: " + actual);
  }
  if (schema.properties || schema.required) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      assert.ok(Object.hasOwn(record, name), "Missing property: " + name);
    }
    for (const [name, member] of Object.entries(record)) {
      if (Object.hasOwn(properties, name)) {
        assertSchema(properties[name]!, member);
      } else {
        assert.notEqual(schema.additionalProperties, false, name);
      }
    }
  }
  if (schema.items || schema.maxItems !== undefined) {
    assert.ok(Array.isArray(value));
    if (schema.maxItems !== undefined) {
      assert.ok(value.length <= schema.maxItems);
    }
    if (schema.items) {
      for (const item of value) assertSchema(schema.items, item);
    }
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    assert.equal(typeof value, "number");
    const number = value as number;
    if (schema.minimum !== undefined) assert.ok(number >= schema.minimum);
    if (schema.maximum !== undefined) assert.ok(number <= schema.maximum);
  }
  if (schema.pattern) {
    assert.equal(typeof value, "string");
    assert.match(value as string, new RegExp(schema.pattern));
  }
  if (schema.format) {
    assert.equal(typeof value, "string");
    const string = value as string;
    if (schema.format === "date-time") {
      assert.ok(Number.isFinite(Date.parse(string)));
      assert.equal(new Date(string).toISOString(), string);
    } else if (schema.format === "date") {
      assert.match(string, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(string).toISOString().slice(0, 10), string);
    } else {
      assert.equal(schema.format, "uuid");
      assert.ok(schema.pattern, "UUID pattern required");
    }
  }
}

export function assertStagingBookingResponse(
  route: string,
  method: "get" | "post",
  status: number,
  response: {
    statusCode: number;
    headers: Record<string, unknown>;
    json(): unknown;
  },
): void {
  assert.equal(response.statusCode, status, route);
  const path = "/v1/organizations/{tenantId}/" + route;
  const contract = spec.paths[path]?.[method]?.responses[String(status)];
  assert.ok(contract, "No response contract for " + path);
  assertSchema(contract.content["application/json"].schema, response.json());
  for (const [name, header] of Object.entries(contract.headers)) {
    assertSchema(header.schema, response.headers[name.toLowerCase()]);
  }
}
