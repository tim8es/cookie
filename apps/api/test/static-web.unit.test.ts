import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import { registerCompiledWeb } from "../src/static-web.js";

test("compiled static web never enables Booking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cookie-static-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><html>Cookie</html>");
  await writeFile(
    join(root, "assets", "app-abc123.js"),
    "export const ready = true;",
  );

  const app = createApp({ query: async () => ({ rows: [] }) });
  t.after(async () => app.close());
  await registerCompiledWeb(app, root);

  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] ?? "", /text\/html/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(page.body, /Cookie/);

  const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers["content-type"] ?? "", /javascript/);
  assert.match(asset.body, /ready = true/);

  const spa = await app.inject({ method: "GET", url: "/salon/schedule" });
  assert.equal(spa.statusCode, 200);
  assert.match(spa.body, /Cookie/);

  for (const url of [
    "/v1/bookings",
    "/v1/organizations/00000000-0000-4000-8000-000000000000/bookings",
    "/health/not-real",
    "/assets/missing.js",
    "/assets/%2e%2e%2fsecret.js",
    "/secret.txt",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.ok(response.statusCode >= 400, `unsafe static fallback for ${url}`);
    assert.doesNotMatch(response.body, /<html>/);
  }
});

test("missing compiled assets prevent static route registration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cookie-static-empty-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createApp({ query: async () => ({ rows: [] }) });
  t.after(async () => app.close());
  await assert.rejects(registerCompiledWeb(app, root), /ENOENT/);
});
