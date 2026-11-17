// CI-only real-runtime isolation evidence through the actual private manager.
// IPC credentials stay in memory; never print a proof or bearer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { authenticateTelegramOwner, exchangeTelegramSession, revokeTelegramOwnerSession } from "../apps/web/src/lib/owner-auth.ts";
import { createRealService, readRealServices } from "../apps/web/src/lib/services-api.ts";
import { localDemoFetch } from "./local-staging-mode.mjs";
import { PrivateDemoManager, spawnPrivateDemoWorker } from "./private-demo-manager.mjs";

if (process.env.CI !== "true") throw new Error("CI=true required for disposable isolation smoke");
const children = [];
const spawnWorker = ttl => {
  const child = spawnPrivateDemoWorker(ttl);
  const exited = new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
  children.push({ child, exited });
  return child;
};
const manager = new PrivateDemoManager({ maxSessions: 2, ttlSeconds: 180, spawnWorker });
const expiry = new PrivateDemoManager({ maxSessions: 1, ttlSeconds: 10, spawnWorker });

async function until(predicate) {
  const end = Date.now() + 90000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Private demo cleanup timed out");
    await pause(100);
  }
}

async function login(supervisor, instance) {
  const fetcher = localDemoFetch(instance.origin);
  const session = await authenticateTelegramOwner(await supervisor.proof(instance.id, "owner"), fetcher);
  assert.equal(session.tenantId, instance.tenantId);
  return { fetcher, session };
}

async function verify() {
  const startingA = manager.start();
  const startingB = manager.start();
  await assert.rejects(manager.start(), /capacity/);
  const [a,b] = await Promise.all([startingA, startingB]);
  assert.equal(manager.status.ready, 2);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.origin, b.origin);
  assert.notEqual(a.tenantId, b.tenantId);
  const aa = await login(manager, a);
  const bb = await login(manager, b);
  await assert.rejects(
    async () => exchangeTelegramSession(await manager.proof(a.id, "owner"), bb.fetcher),
    error => error?.reason === "unauthorized",
  );
  await assert.rejects(
    async () => exchangeTelegramSession(await manager.proof(b.id, "owner"), aa.fetcher),
    error => error?.reason === "unauthorized",
  );
  for (const [own, other] of [[aa,bb],[bb,aa]]) {
    const response = await other.fetcher("/v1/organizations/" + other.session.tenantId + "/services", {
      headers: { authorization: "Bearer " + own.session.accessToken },
    });
    assert.ok([401,403].includes(response.status), "Foreign bearer accepted");
    assert.equal((await readRealServices(own.session, own.fetcher)).length, 1);
  }
  const marker = "Synthetic isolation catalog change";
  await createRealService(aa.session, {
    displayName: marker, durationMinutes: 30, basePriceKopecks: 95000,
  }, randomUUID(), aa.fetcher);
  assert.ok((await readRealServices(aa.session, aa.fetcher)).some(s => s.displayName === marker));
  assert.ok(!(await readRealServices(bb.session, bb.fetcher)).some(s => s.displayName === marker));

  await revokeTelegramOwnerSession(aa.session, aa.fetcher);
  const stopping = manager.stop(a.id);
  await assert.rejects(manager.start(), /capacity/);
  await stopping;
  assert.equal(manager.status.ready, 1);
  assert.equal((await readRealServices(bb.session, bb.fetcher)).length, 1);
  await revokeTelegramOwnerSession(bb.session, bb.fetcher);
  // The second live worker must clean itself on loss of its parent IPC.
  children[1].child.disconnect();
  await until(() => manager.status.ready + manager.status.stopping === 0);
  assert.equal(manager.status.quarantined, 0);
  assert.deepEqual(await children[1].exited, { code: 0, signal: null });

  const c = await expiry.start();
  const cc = await login(expiry, c);
  const catalog = await readRealServices(cc.session, cc.fetcher);
  assert.equal(catalog.length, 1);
  assert.ok(!catalog.some(s => s.displayName === marker));
  await revokeTelegramOwnerSession(cc.session, cc.fetcher);
  await until(() => expiry.status.ready + expiry.status.stopping === 0);
  assert.equal(expiry.status.quarantined, 0);
  assert.deepEqual(await children[2].exited, { code: 0, signal: null });
  await assert.rejects(expiry.proof(c.id, "owner"), /unavailable/);
  console.log("PASS private demo isolation: manager admission, independent live databases, foreign proof/bearer denial, write isolation, targeted cleanup, disconnect, reset and TTL");
}
try {
  await verify();
} finally {
  const results = await Promise.allSettled([manager.close(), expiry.close()]);
  if (results.some(r => r.status === "rejected")) {
    // Do not delete unrelated Docker resources or claim cleanup.
    throw new Error("Private demo cleanup unconfirmed; inspect disposable project state");
  }
}
