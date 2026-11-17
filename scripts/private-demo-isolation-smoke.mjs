// CI-only integration evidence for two live, independently seeded real runtimes.
// The parent keeps credentials in memory and never serializes them to logs.
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { authenticateTelegramOwner, exchangeTelegramSession, revokeTelegramOwnerSession } from "../apps/web/src/lib/owner-auth.ts";
import { createRealService, readRealServices } from "../apps/web/src/lib/services-api.ts";
import { isLocalStagingProject, localDemoFetch, resolveLocalStagingMode } from "./local-staging-mode.mjs";

if (process.env.CI !== "true") throw new Error("CI=true required for disposable isolation smoke");
const launcher = fileURLToPath(new URL("./local-staging.mjs", import.meta.url));
const demo = resolveLocalStagingMode(["demo"]);
const workers = [];
let nextId = 0;

function deadline(promise, ms, stage) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timeout: " + stage)), ms);
  })]).finally(() => clearTimeout(timer));
}

function message(worker, type, id) {
  const child = worker.child;
  return deadline(new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", receive);
      child.off("exit", failed);
      child.off("error", failed);
    };
    const failed = () => { cleanup(); reject(new Error("Demo worker stopped before " + type)); };
    const receive = (incoming) => {
      if (incoming?.type !== type || (id !== undefined && incoming.id !== id)) return;
      cleanup();
      resolve(incoming);
    };
    child.on("message", receive);
    child.once("exit", failed);
    child.once("error", failed);
    if (child.exitCode !== null || child.signalCode !== null) failed();
  }), 120000, type);
}

async function start(ttl) {
  const child = fork(launcher, ["serve-demo"], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, COOKIE_DEMO_WORKER_TTL_SECONDS: String(ttl) },
  });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
  const worker = { child, exit, ready: null, stopped: false };
  workers.push(worker);
  worker.ready = await message(worker, "ready");
  assert.ok(isLocalStagingProject(demo, worker.ready.project), "Unexpected Compose project");
  worker.fetch = localDemoFetch(worker.ready.origin);
  return worker;
}

async function freshProof(worker, role = "owner") {
  const id = ++nextId;
  const reply = message(worker, "proof", id);
  worker.child.send({ type: "proof", id, role });
  const value = (await reply).proof;
  assert.ok(typeof value === "string" && value.length > 0, "Missing signed input");
  return value;
}

async function login(worker) {
  const session = await authenticateTelegramOwner(await freshProof(worker), worker.fetch);
  assert.equal(session.tenantId, worker.ready.tenantId);
  return session;
}

function assertRemoved(worker) {
  if (!worker.ready) return;
  const label = "label=com.docker.compose.project=" + worker.ready.project;
  for (const args of [
    ["ps", "-aq", "--filter", label],
    ["volume", "ls", "-q", "--filter", label],
    ["network", "ls", "-q", "--filter", label],
  ]) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, "Docker cleanup probe failed");
    assert.equal(result.stdout.trim(), "", "Disposable Compose resources remain");
  }
}

async function stop(worker, how = "stop") {
  if (worker.stopped) return;
  if (worker.child.connected) {
    if (how === "disconnect") worker.child.disconnect();
    else if (how === "stop") worker.child.send({ type: "stop" }, () => {});
  }
  const exit = await deadline(worker.exit, 90000, "demo worker cleanup");
  assert.equal(exit.code, 0, "Demo worker did not exit cleanly");
  assert.equal(exit.signal, null);
  worker.stopped = true;
  assertRemoved(worker);
}

async function verify() {
  const a = await start(180);
  const b = await start(180);
  assert.notEqual(a.ready.project, b.ready.project);
  assert.notEqual(a.ready.origin, b.ready.origin);
  assert.notEqual(a.ready.tenantId, b.ready.tenantId);
  const sa = await login(a);
  const sb = await login(b);
  // A proof is signed for exactly one synthetic runtime; reject the other
  // without ever printing the proof or bearer in assertion failure output.
  await assert.rejects(
    async () => exchangeTelegramSession(await freshProof(a), b.fetch),
    (error) => error?.reason === "unauthorized",
  );
  await assert.rejects(
    async () => exchangeTelegramSession(await freshProof(b), a.fetch),
    (error) => error?.reason === "unauthorized",
  );
  for (const [own, other, ownSession, otherSession] of [[a,b,sa,sb],[b,a,sb,sa]]) {
    const response = await other.fetch("/v1/organizations/" + otherSession.tenantId + "/services", {
      headers: { authorization: "Bearer " + ownSession.accessToken },
    });
    assert.ok([401,403].includes(response.status), "Foreign bearer accepted");
    assert.equal((await readRealServices(ownSession, own.fetch)).length, 1);
  }
  const marker = "Synthetic isolation catalog change";
  await createRealService(sa, {
    displayName: marker, durationMinutes: 30, basePriceKopecks: 95000,
  }, randomUUID(), a.fetch);
  assert.ok((await readRealServices(sa, a.fetch)).some(s => s.displayName === marker));
  assert.ok(!(await readRealServices(sb, b.fetch)).some(s => s.displayName === marker));

  await revokeTelegramOwnerSession(sa, a.fetch);
  await stop(a);
  // Closing A must not disrupt B's actual authenticated catalog.
  assert.equal((await readRealServices(sb, b.fetch)).length, 1);
  await revokeTelegramOwnerSession(sb, b.fetch);
  await stop(b, "disconnect");

  // A fresh third runtime has only the baseline example. It then expires
  // without a stop command (independent of browser/IPC requests).
  const c = await start(10);
  const sc = await login(c);
  const catalog = await readRealServices(sc, c.fetch);
  assert.equal(catalog.length, 1);
  assert.ok(!catalog.some(s => s.displayName === marker));
  await revokeTelegramOwnerSession(sc, c.fetch);
  await stop(c, "expiry");
  console.log("PASS private demo isolation: independent live databases, foreign proof/bearer denial, write isolation, targeted cleanup, disconnect, reset and TTL");
}

try {
  await verify();
} finally {
  for (const worker of workers) {
    if (worker.stopped) continue;
    try {
      if (worker.child.connected) worker.child.disconnect();
      await deadline(worker.exit, 30000, "failure cleanup");
      assertRemoved(worker);
    } catch {
      worker.child.kill("SIGTERM");
      try { await deadline(worker.exit, 15000, "signal cleanup"); assertRemoved(worker); }
      catch { worker.child.kill("SIGKILL"); throw new Error("Private demo cleanup not confirmed; inspect only disposable project state"); }
    }
  }
}
