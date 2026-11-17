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
