import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSyntheticRefreshHttp } from "../src/synthetic-refresh-http.js";

test("synthetic refresh HTTP rejects foreign origin, malformed credentials and override parameters", async (t) => {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const calls: string[] = [];
  registerSyntheticRefreshHttp(app, {
    async login() {
      calls.push("login");
      return null;
    },
    async rotate() {
      calls.push("rotate");
      throw new Error("synthetic uncertain commit");
    },
    async logout() {
      calls.push("logout");
      return false;
    },
  });
  const path = "/v1/auth/synthetic-refresh";
  const browser = {
    "sec-fetch-site": "same-origin",
    "x-kuki-session": "1",
  };
  const cookie = "__Host-kuki-refresh-candidate=ir_" + "A".repeat(43);
  const bearer = "Bearer is_" + "B".repeat(43);
  const cross = await app.inject({
    method: "POST",
    url: path + "/login",
    headers: { ...browser, "sec-fetch-site": "same-site" },
    payload: { initData: "synthetic" },
  });
  assert.equal(cross.statusCode, 403);
  const badInputs = [
    { url: "/login", payload: { initData: "synthetic", lifetime: 9999 } },
    {
      url: "/login",
      headers: { authorization: bearer },
      payload: { initData: "synthetic" },
    },
    { url: "/rotate?ttl=99999", headers: { cookie } },
    { url: "/rotate", headers: { cookie: cookie + "; " + cookie } },
    { url: "/rotate", headers: { cookie, authorization: "Bearer invalid" } },
    { url: "/rotate", payload: { refreshToken: "ir_" + "A".repeat(43) } },
    { url: "/logout", headers: { cookie } },
  ];
  for (const input of badInputs) {
    const result = await app.inject({
      method: "POST",
      url: path + input.url,
      headers: { ...browser, ...input.headers },
      ...(input.payload ? { payload: input.payload } : {}),
    });
    assert.ok([400, 401].includes(result.statusCode));
    assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(result.headers["cache-control"], "no-store");
  }
  assert.deepEqual(calls, []);
  const uncertain = await app.inject({
    method: "POST",
    url: path + "/rotate",
    headers: { ...browser, cookie, authorization: bearer },
  });
  assert.equal(uncertain.statusCode, 503);
  assert.deepEqual(uncertain.json(), { error: "BACKEND_UNAVAILABLE" });
  assert.equal(uncertain.headers["set-cookie"], undefined);
  assert.deepEqual(calls, ["rotate"]);
});
