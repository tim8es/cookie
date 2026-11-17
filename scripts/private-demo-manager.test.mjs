import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PrivateDemoManager } from "./private-demo-manager.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const children = [];
  const cleaned = [];
  const manager = new PrivateDemoManager({
    maxSessions: 1, ttlSeconds: 60, startupMs: 1000, stopMs: 1000,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.connected = true;
      child.pid = 42;
      child.commands = [];
      child.send = (message, callback) => { child.commands.push(message); callback?.(); };
      child.disconnect = () => { child.connected = false; child.emit("disconnect"); };
      children.push(child);
      return child;
    },
    verifyCleanup: project => { cleaned.push(project); return true; },
    ...options,
  });
  return { manager, children, cleaned };
}
function allocated(child, n = 1) {
  child.emit("message", { type: "allocated", project: "cookie-demo-" + String(n).padStart(12, "0") });
}
function ready(child, n = 1) {
  allocated(child, n);
  child.emit("message", { type: "ready", origin: "http://127.0.0.1:1234",
    project: "cookie-demo-" + String(n).padStart(12, "0"), tenantId });
}

test("capacity counts starting, ready and stopping workers; reuse only after verified cleanup", async () => {
  const { manager, children, cleaned } = harness();
  const first = manager.start();
  assert.equal(manager.status.starting, 1);
  await assert.rejects(manager.start(), /capacity/);
  ready(children[0]);
  const a = await first;
  assert.equal(manager.status.ready, 1);
  const proof = manager.proof(a.id, "client");
  const request = children[0].commands.at(-1);
  assert.equal(request.role, "client");
  await assert.rejects(manager.proof(a.id, "owner"), /unavailable/);
  await assert.rejects(manager.proof("foreign", "owner"), /unavailable/);
  children[0].emit("message", { type: "proof", id: request.id + 1, proof: "wrong" });
  children[0].emit("message", { type: "proof", id: request.id, proof: "synthetic-proof" });
  assert.equal(await proof, "synthetic-proof");
  const stopping = manager.stop(a.id);
  assert.equal(manager.status.stopping, 1);
  await assert.rejects(manager.start(), /capacity/);
  await assert.rejects(manager.proof(a.id, "owner"), /unavailable/);
  children[0].emit("exit", 0, null);
  await stopping;
  assert.deepEqual(cleaned, ["cookie-demo-000000000001"]);
  const second = manager.start();
  ready(children[1], 2);
  const b = await second;
  assert.notEqual(a.id, b.id);
  const closing = manager.close();
  children[1].emit("exit", 0, null);
  await closing;
  assert.equal(manager.status.closed, true);
  await assert.rejects(manager.start(), /capacity/);
});

test("uncertain cleanup quarantines capacity, even if worker exits normally", async () => {
  const { manager, children } = harness({ verifyCleanup: () => false });
  const starting = manager.start();
  ready(children[0]);
  const a = await starting;
  const stopping = manager.stop(a.id);
  children[0].emit("exit", 0, null);
  await assert.rejects(stopping, /unconfirmed/);
  assert.equal(manager.status.quarantined, 1);
  await assert.rejects(manager.start(), /capacity/);
  await assert.rejects(manager.close(), /unconfirmed/);
});

test("startup failure and invalid readiness fail closed; cleanup evidence is required", async () => {
  const { manager, children } = harness();
  const first = manager.start();
  allocated(children[0]);
  children[0].emit("message", { type: "ready", project: "cookie-demo-000000000001",
    origin: "https://example.invalid", tenantId });
  await assert.rejects(first, /Invalid/);
  assert.equal(manager.status.stopping, 1);
  assert.equal(children[0].connected, false);
  children[0].emit("exit", 1, null);
  await tick();
  assert.equal(manager.status.stopping, 0);
  const second = manager.start();
  children[1].emit("exit", 1, null);
  await assert.rejects(second, /exited/);
  await tick();
  assert.equal(manager.status.quarantined, 1);
  await assert.rejects(manager.start(), /capacity/);
});

test("manager closure during startup reserves resources until worker has exited", async () => {
  const { manager, children } = harness();
  const starting = manager.start();
  allocated(children[0]);
  const closing = manager.close();
  await assert.rejects(starting, /stopped/);
  assert.equal(children[0].connected, false);
  assert.equal(manager.status.stopping, 1);
  children[0].emit("exit", 0, null);
  await closing;
  assert.equal(manager.status.stopping, 0);
  assert.equal(manager.status.closed, true);
});

test("routes use only a live bound worker, canonical API paths and allowed headers", async () => {
  const calls = [];
  const { manager, children } = harness({ fetcher: async (url, init) => {
    calls.push({ url, init });
    return new Response("{}");
  } });
  assert.throws(() => manager.route("foreign"), /unavailable/);
  const starting = manager.start();
  ready(children[0]);
  const a = await starting;
  const route = manager.route(a.id);
  for (const path of ["https://example.invalid/v1/test", "//127.0.0.1:9999/v1/test",
    "/v1/../test", "/v1/%2e%2e/test", "/v1//test", "/v1/test#fragment",
    "/v1/test\\other", "/assets/test.js", "/v1/test?x=bad space"]) {
    await assert.rejects(route(path), /path rejected/);
  }
  for (const headers of [{ host: "other" }, { cookie: "sid=synthetic" },
    { "x-forwarded-host": "other" }, { "x-demo-session": "other" }]) {
    await assert.rejects(route("/v1/test", { headers }), /header rejected/);
  }
  await assert.rejects(route("/v1/test", { method: "CONNECT" }), /method/);
  await assert.rejects(route("/v1/test", { body: "{}" }), /body/);
  await assert.rejects(route("/v1/test", { method: "POST", body: "x".repeat(256 * 1024 + 1) }), /body/);
  assert.equal(calls.length, 0);
  await route("/v1/organizations/" + tenantId + "/services?limit=1", {
    headers: { authorization: "Bearer synthetic", accept: "application/json" },
    redirect: "follow", credentials: "include", dispatcher: "ignored",
  });
  assert.equal(calls[0].url, "http://127.0.0.1:1234/v1/organizations/" + tenantId + "/services?limit=1");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer synthetic");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.dispatcher, undefined);

  const stopping = manager.stop(a.id);
  assert.equal(calls[0].init.signal.aborted, true);
  await assert.rejects(route("/v1/test"), /unavailable/);
  children[0].emit("exit", 0, null);
  await stopping;
  const second = manager.start();
  ready(children[1], 2); // reuse the same port with a different session id
  const b = await second;
  await assert.rejects(route("/v1/test"), /unavailable/);
  await manager.route(b.id)("/v1/test");
  assert.equal(calls.length, 2);
  const closing = manager.close();
  children[1].emit("exit", 0, null);
  await closing;
});

test("in-flight route rejects a late response after IPC disconnect", async () => {
  let deliver;
  let forwarded;
  const { manager, children } = harness({ fetcher: (_url, init) => {
    forwarded = init.signal;
    return new Promise(resolve => { deliver = resolve; });
  } });
  const starting = manager.start();
  ready(children[0]);
  const a = await starting;
  const route = manager.route(a.id);
  const pending = route("/v1/test");
  children[0].disconnect();
  assert.equal(forwarded.aborted, true);
  deliver(new Response("late"));
  await assert.rejects(pending, /unavailable/);
  await assert.rejects(route("/v1/test"), /unavailable/);
  children[0].emit("exit", 0, null);
  await tick();
  await manager.close();
});

test("known stopped session recovery releases capacity only after verified removal", async () => {
  const recovered = [];
  let clean = false;
  let permitRecovery = false;
  const { manager, children } = harness({
    verifyCleanup: () => clean,
    recoverProject: (project, origin) => {
      recovered.push({ project, origin });
      if (permitRecovery) clean = true;
      return permitRecovery;
    },
  });
  const starting = manager.start();
  ready(children[0]);
  const a = await starting;
  await assert.rejects(manager.recover(a.id), /unavailable/);
  await assert.rejects(manager.recover("unknown"), /unavailable/);
  children[0].emit("exit", null, "SIGKILL");
  await tick();
  assert.equal(manager.status.quarantined, 1);
  await assert.rejects(manager.recover(a.id), /unconfirmed/);
  await assert.rejects(manager.start(), /capacity/);
  permitRecovery = true;
  assert.equal(await manager.recover(a.id), true);
  assert.equal(manager.status.quarantined, 0);
  assert.deepEqual(recovered, Array(2).fill({
    project: "cookie-demo-000000000001", origin: "http://127.0.0.1:1234",
  }));
  await manager.close();
});

test("unknown or never-ready allocation cannot be recovered destructively", async () => {
  let calls = 0;
  const { manager, children } = harness({
    verifyCleanup: () => false,
    recoverProject: () => { calls++; return true; },
  });
  const starting = manager.start();
  allocated(children[0]);
  children[0].emit("exit", null, "SIGKILL");
  await assert.rejects(starting, /exited/);
  await tick();
  assert.equal(manager.status.quarantined, 1);
  assert.equal(calls, 0);
  await assert.rejects(manager.close(), /unconfirmed/);
});
