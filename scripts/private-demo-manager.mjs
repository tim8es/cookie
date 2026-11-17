// Trusted local supervisor primitives. Not a public admission or HTTP service.
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isLocalStagingProject, localDemoFetch, privateDemoLifetime, resolveLocalStagingMode } from "./local-staging-mode.mjs";

import { recoverPrivateDemoProject } from "./private-demo-recovery.mjs";

const launcher = fileURLToPath(new URL("./local-staging.mjs", import.meta.url));
const mode = resolveLocalStagingMode(["demo"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function spawnPrivateDemoWorker(ttlSeconds) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(COOKIE_|DATABASE_URL$|PG|NODE_OPTIONS$)/i.test(key)));
  return fork(launcher, ["serve-demo"], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...env, COOKIE_DEMO_WORKER_TTL_SECONDS: String(ttlSeconds) },
  });
}

function cleanProject(project) {
  if (!isLocalStagingProject(mode, project)) return false;
  const label = "label=com.docker.compose.project=" + project;
  return [
    ["ps", "-aq", "--filter", label],
    ["volume", "ls", "-q", "--filter", label],
    ["network", "ls", "-q", "--filter", label],
  ].every(args => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 10000 });
    return result.status === 0 && result.stdout.trim() === "";
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // An exit can precede the caller awaiting start/stop; never emit an
  // unhandled rejection for an internal state transition.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function bounded(promise, ms, reason) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  })]).finally(() => clearTimeout(timer));
}

export class PrivateDemoManager {
  #records = new Map();
  #closed = false;
  #sequence = 0;
  #launch;
  #clean;
  #max;
  #ttl;
  #startup;
  #stopTimeout;
  #fetch;
  #recover;

  constructor({ maxSessions, ttlSeconds, startupMs = 120000, stopMs = 90000,
    spawnWorker = spawnPrivateDemoWorker, verifyCleanup = cleanProject, fetcher = globalThis.fetch,
    recoverProject = recoverPrivateDemoProject }) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 16 ||
        !Number.isInteger(startupMs) || startupMs < 1 || startupMs > 120000 ||
        !Number.isInteger(stopMs) || stopMs < 1 || stopMs > 120000) {
      throw new Error("Invalid private demo infrastructure limits");
    }
    privateDemoLifetime(true, String(ttlSeconds));
    this.#max = maxSessions;
    this.#ttl = ttlSeconds;
    this.#startup = startupMs;
    this.#stopTimeout = stopMs;
    this.#launch = spawnWorker;
    this.#clean = verifyCleanup;
    this.#fetch = fetcher;
    this.#recover = recoverProject;
  }

  get status() {
    const counts = { starting: 0, ready: 0, stopping: 0, quarantined: 0 };
    for (const record of this.#records.values()) counts[record.state]++;
    return { ...counts, capacity: this.#max, closed: this.#closed };
  }

  async start() {
    if (this.#closed || this.#records.size >= this.#max) throw new Error("Private demo capacity unavailable");
    const id = randomUUID();
    const record = { id, state: "starting", started: deferred(), exited: deferred(),
      pending: new Map(), project: null, child: null, info: null, finalizing: false,
      routeAbort: new AbortController() };
    // Reserve synchronously, before spawning or awaiting network readiness.
    this.#records.set(id, record);
    try {
      record.child = this.#launch(this.#ttl);
      const child = record.child;
      child.on("message", message => this.#message(record, message));
      child.once("exit", (code, signal) => void this.#exit(record, code, signal));
      child.once("disconnect", () => this.#requestStop(record));
      child.once("error", () => {
        // A spawn error can mean there was no child. Fail closed; do not
        // release a slot just because the process handle emitted an error.
        record.started.reject(new Error("Private demo process failed"));
        this.#requestStop(record);
        if (!child.pid) void this.#exit(record, 1, null);
      });
      return await bounded(record.started.promise, this.#startup, "Private demo startup timeout");
    } catch (error) {
      if (record.child) this.#requestStop(record);
      else {
        record.state = "quarantined";
        record.exited.reject(new Error("Private demo start was not confirmed"));
      }
      throw error;
    }
  }

  #message(record, message) {
    if (!message || typeof message !== "object" || record.finalizing) return;
    if (message.type === "allocated" && ["starting", "stopping"].includes(record.state)) {
      if (record.project || !isLocalStagingProject(mode, message.project)) {
        record.started.reject(new Error("Invalid demo resource allocation"));
        this.#requestStop(record);
        return;
      }
      record.project = message.project;
    } else if (message.type === "ready" && record.state === "starting") {
      try {
        localDemoFetch(message.origin);
        if (message.project !== record.project || !UUID.test(message.tenantId)) throw new Error();
        record.info = Object.freeze({ id: record.id, origin: message.origin, tenantId: message.tenantId });
        record.state = "ready";
        record.started.resolve(record.info);
      } catch {
        record.started.reject(new Error("Invalid private demo readiness"));
        this.#requestStop(record);
      }
    } else if (message.type === "proof" && record.state === "ready") {
      const pending = record.pending.get(message.id);
      if (!pending) return;
      record.pending.delete(message.id);
      if (typeof message.proof !== "string" || !message.proof || message.proof.length > 8192) {
        pending.reject(new Error("Invalid private proof response"));
      } else pending.resolve(message.proof);
    }
  }

  // Trusted in-process routing. The caller supplies a session id once;
  // no URL, host, role or tenant from request parameters can retarget it.
  // Existing server auth still verifies every operation independently.
  route(id) {
    const record = this.#records.get(id);
    const available = () => !this.#closed && this.#records.get(id) === record &&
      record?.state === "ready" && record.child.connected && !record.routeAbort.signal.aborted;
    if (!available()) throw new Error("Private demo route unavailable");
    const transport = localDemoFetch(record.info.origin, this.#fetch);
    return async (path, init = {}) => {
      if (!available()) throw new Error("Private demo route unavailable");
      const method = String(init.method ?? "GET").toUpperCase();
      if (!["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"].includes(method)) {
        throw new Error("Private demo method rejected");
      }
      // Only canonical API paths; no absolute URLs, encoded segments,
      // repeated slashes, traversal, fragments or ambiguous path separators.
      if (typeof path !== "string" || path.length > 4096 ||
          !/^\/v1\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\?[^#\\\x00-\x20]*)?$/.test(path)) {
        throw new Error("Private demo API path rejected");
      }
      const headers = new Headers(init.headers);
      for (const name of headers.keys()) {
        if (!["accept", "authorization", "content-type", "idempotency-key"].includes(name)) {
          throw new Error("Private demo header rejected");
        }
      }
      if (init.body != null && (typeof init.body !== "string" ||
          Buffer.byteLength(init.body, "utf8") > 256 * 1024 ||
          ["GET", "HEAD"].includes(method))) {
        throw new Error("Private demo request body rejected");
      }
      // Ignore other fetch options (dispatcher, credentials, redirect, etc).
      // Cancellation is scoped to this exact record, not its reusable port.
      const signals = [record.routeAbort.signal, AbortSignal.timeout(15000)];
      if (init.signal) signals.push(init.signal);
      const signal = AbortSignal.any(signals);
      const response = await transport(path, {
        method, headers, ...(init.body == null ? {} : { body: init.body }),
        signal, cache: "no-store", referrerPolicy: "no-referrer",
      });
      if (!available() || signal.aborted) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Private demo route unavailable");
      }
      return response;
    };
  }

  async proof(id, role) {
    const record = this.#records.get(id);
    if (this.#closed || record?.state !== "ready" || !record.child.connected ||
        !["owner", "client"].includes(role) || record.pending.size >= 1) {
      throw new Error("Private demo proof unavailable");
    }
    const requestId = ++this.#sequence;
    const result = deferred();
    record.pending.set(requestId, result);
    try {
      record.child.send({ type: "proof", id: requestId, role }, error => {
        if (error) result.reject(new Error("Private demo IPC failed"));
      });
      return await bounded(result.promise, 5000, "Private demo proof timeout");
    } finally { record.pending.delete(requestId); }
  }

  #requestStop(record) {
    if (record.finalizing || record.state === "quarantined" || record.state === "stopping") return;
    const wasReady = record.state === "ready";
    record.state = "stopping";
    record.routeAbort.abort();
    record.started.reject(new Error("Private demo stopped before readiness"));
    for (const pending of record.pending.values()) pending.reject(new Error("Private demo stopped"));
    record.pending.clear();
    try {
      if (record.child?.connected) {
        if (wasReady) record.child.send({ type: "stop" }, error => {
          if (error && record.child.connected) {
            try { record.child.disconnect(); } catch { /* Await cleanup evidence. */ }
          }
        });
        else record.child.disconnect();
      }
    } catch { /* Slot remains reserved pending exit and verified cleanup. */ }
  }

  async #exit(record, code, signal) {
    if (record.finalizing) return;
    record.finalizing = true;
    record.exitObserved = { code, signal };
    record.state = "stopping";
    record.routeAbort.abort();
    record.started.reject(new Error("Private demo exited before readiness"));
    for (const pending of record.pending.values()) pending.reject(new Error("Private demo exited"));
    record.pending.clear();
    let clean = false;
    try {
      // No allocation notification => no proof of cleanup. Keep capacity
      // reserved rather than silently assuming the worker never started.
      clean = !!record.project && await this.#clean(record.project) === true;
    } catch { /* Quarantine on Docker failure or ambiguous evidence. */ }
    if (clean) {
      this.#records.delete(record.id);
      record.exited.resolve({ code, signal });
    } else {
      record.state = "quarantined";
      record.exited.reject(new Error("Private demo resource cleanup unconfirmed"));
    }
  }

  async stop(id) {
    const record = this.#records.get(id);
    if (!record) return;
    this.#requestStop(record);
    const exit = await bounded(record.exited.promise, this.#stopTimeout, "Private demo cleanup timeout");
    if (exit.code !== 0 || exit.signal !== null) throw new Error("Private demo exited abnormally after cleanup");
    return exit;
  }

  // Operator-only retry for an observed crash after a verified readiness.
  // No caller-supplied project, port, credentials, or destructive sweep.
  async recover(id) {
    const record = this.#records.get(id);
    if (this.#closed || record?.state !== "quarantined" || !record.exitObserved ||
        !record.info || !record.project) throw new Error("Private demo recovery unavailable");
    record.state = "stopping";
    try {
      const recovered = await this.#recover(record.project, record.info.origin);
      if (recovered !== true || await this.#clean(record.project) !== true) {
        throw new Error("Private demo recovery unconfirmed");
      }
      this.#records.delete(record.id);
      return true;
    } catch {
      record.state = "quarantined";
      throw new Error("Private demo recovery unconfirmed");
    }
  }

  async close() {
    this.#closed = true;
    const results = await Promise.allSettled([...this.#records.keys()].map(id => this.stop(id)));
    if (results.some(result => result.status === "rejected")) {
      throw new Error("Private demo manager closed with unconfirmed cleanup");
    }
  }
}
