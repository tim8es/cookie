// Isolated real Chromium + PostgreSQL test for #359. No deployment entrypoint.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import { browserBinary, freePort, poll, getLocal, createClient, evaluate } from "./browser-smoke.mjs";
import { startChromiumWithRetry } from "../../../scripts/f1-chromium-startup.mjs";
import { runMigrations } from "../../../dist/packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../dist/packages/platform-db/src/transaction.js";
import { IdentitySessions } from "../../../dist/packages/platform-identity/src/identity-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../dist/packages/platform-identity/src/telegram-init-data.js";
import { exchangeSelfServiceTelegram } from "../../../dist/packages/platform-identity/src/telegram-self-registration.js";
import { SyntheticTelegramRefresh } from "../../../dist/packages/platform-identity/src/synthetic-telegram-refresh.js";
import { registerSyntheticRefreshHttp } from "../../../dist/apps/api/src/synthetic-refresh-http.js";

const require = createRequire(new URL("../../api/package.json", import.meta.url));
const Fastify = require("fastify");

function isolatedDatabase() {
  if (process.env.CI !== "true" || !process.env.TEST_DATABASE_URL)
    throw new Error("Requires dedicated CI database");
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.pathname !== "/cookie_ci")
    throw new Error("Refusing refresh smoke outside loopback cookie_ci");
  return process.env.TEST_DATABASE_URL;
}

function proof(botToken, userId) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: userId }),
  };
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => name + "=" + value).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  return new URLSearchParams({
    ...fields, hash: createHmac("sha256", key).update(check).digest("hex"),
  }).toString();
}

async function disposeBrowser({ chrome, dir }) {
  if (chrome.exitCode === null && chrome.signalCode === null && chrome.pid !== undefined) {
    const exited = new Promise((done) => chrome.once("close", done));
    chrome.kill("SIGTERM");
    if (!(await Promise.race([exited.then(() => true), pause(1000).then(() => false)]))) {
      chrome.kill("SIGKILL");
      await Promise.race([exited, pause(1000)]);
    }
    if (chrome.exitCode === null && chrome.signalCode === null)
      throw new Error("Chromium did not terminate");
  }
  rmSync(dir, { recursive: true, force: true });
}

function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Browser evaluation timed out")), 20000);
    }),
  ]).finally(() => clearTimeout(timer));
}

const html = `<!doctype html><meta charset="utf-8"><title>Synthetic refresh CI</title>
<script type="module">
import { createCandidateRefreshBrowser } from "/candidate.js";
const send = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await send(input, init);
  if (window.holdNextRotation && String(input).endsWith("/rotate")) {
    window.holdNextRotation = false;
    window.rotationHeld = true;
    await new Promise(resolve => { window.releaseRotation = resolve; });
    if (window.loseRotation) throw new Error("Synthetic response loss");
  }
  return response;
};
window.controller = createCandidateRefreshBrowser(window);
window.controllerReady = Boolean(window.controller);
</script>`;

async function main() {
  const pool = new Pool({ connectionString: isolatedDatabase(), max: 4 });
  const app = Fastify({ logger: false });
  const testIds = [];
  const clients = [];
  let handle;
  try {
    await runMigrations(pool, resolve("db/migrations"));
    const token = "123456789:" + randomBytes(24).toString("base64url");
    const secret = randomBytes(32);
    const users = [randomInt(100000000, 999999999), randomInt(1000000000, 1999999999)];
    const verifier = createTelegramMiniAppProofVerifier({ botToken: token, maxAgeSeconds: 300 });
    const transaction = (work) => runSqlTransaction(pool, work);
    const identitySessions = new IdentitySessions(pool, "cookie-telegram", "cookie-web", 900);
    for (const user of users) {
      const registered = await exchangeSelfServiceTelegram(
        transaction, verifier, secret, proof(token, user), true, 900,
      );
      assert.ok(registered, "Synthetic registration failed");
      const identity = await identitySessions.resolve(registered.token);
      assert.ok(identity, "Synthetic identity not resolved");
      testIds.push(identity);
      await identitySessions.revoke(registered.token);
    }
    const service = new SyntheticTelegramRefresh(transaction, verifier, secret, {
      idleSeconds: 120, absoluteSeconds: 300, accessSeconds: 60,
    });
    let active = 0, maxActive = 0, rotates = 0;
    registerSyntheticRefreshHttp(app, {
      login: (value) => service.login(value),
      rotate: async (...args) => {
        rotates++;
        active++;
        maxActive = Math.max(maxActive, active);
        try { return await service.rotate(...args); }
        finally { active--; }
      },
      logout: (...args) => service.logout(...args),
    });
    const js = stripTypeScriptTypes(
      readFileSync(new URL("../src/lib/synthetic-refresh-browser.ts", import.meta.url), "utf8"),
      { mode: "transform" },
    );
    app.get("/", async (_request, reply) => reply.type("text/html").send(html));
    app.get("/candidate.js", async (_request, reply) =>
      reply.type("application/javascript").send(js));
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const started = await startChromiumWithRetry({
      startAttempt: async () => {
        const dir = mkdtempSync(join(tmpdir(), "kuki-refresh-browser-"));
        const port = await freePort();
        const chrome = spawn(browserBinary(), [
          "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
          "--disable-background-networking", "--no-first-run",
          "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
          "--user-data-dir=" + dir, "about:blank",
        ], { stdio: "ignore" });
        const result = { chrome, dir, port };
        chrome.once("error", () => { result.startupError = "spawn failed"; });
        return result;
      },
      probe: async ({ port }) => {
        const result = await getLocal("http://127.0.0.1:" + port + "/json/list");
        return JSON.parse(result.text).find((page) => page.type === "page" && page.webSocketDebuggerUrl);
      },
      disposeAttempt: disposeBrowser,
    });
    handle = started.handle;
    async function connect(target) {
      const cdp = createClient(target.webSocketDebuggerUrl);
      clients.push(cdp);
      await bounded(cdp.ready);
      await bounded(cdp.send("Page.enable"));
      await bounded(cdp.send("Runtime.enable"));
      await bounded(cdp.send("Network.enable"));
      await bounded(cdp.send("Network.setBlockedURLs", { urls: ["https://*"] }));
      return cdp;
    }
    const a = await connect(started.ready);
    const run = (cdp, expression) => bounded(evaluate(cdp, expression));
    const ready = (cdp) => poll("real Web Locks controller", () =>
      run(cdp, "window.controllerReady === true && window.isSecureContext"));
    await a.send("Page.navigate", { url: origin + "/?tab=1" });
    await ready(a);
    const familyA = await run(a,
      "controller.login(" + JSON.stringify(proof(token, users[0])) + ").then(s=>s?.familyId)");
    assert.ok(familyA, "Real browser login failed");
    assert.equal(await run(a, "document.cookie.includes('__Host-kuki-refresh-candidate')"), false);

    await run(a, "Boolean(window.open(" + JSON.stringify(origin + "/?tab=2") + ", '_blank'))");
    const second = await poll("second actual Chromium tab", async () => {
      const result = await getLocal("http://127.0.0.1:" + handle.port + "/json/list");
      return JSON.parse(result.text).find(page => page.type === "page" &&
        page.url === origin + "/?tab=2" && page.webSocketDebuggerUrl);
    });
    const b = await connect(second);
    await ready(b);
    assert.equal(await run(b, "controller.restore().then(s=>s?.familyId)"), familyA);
    const count = rotates;
    const concurrent = await Promise.all([
      run(a, "controller.renewIfNeeded(3600).then(s=>s?.familyId)"),
      run(b, "controller.renewIfNeeded(3600).then(s=>s?.familyId)"),
    ]);
    assert.deepEqual(concurrent, [familyA, familyA]);
    assert.equal(rotates, count + 2);
    assert.equal(maxActive, 1);

    // Delay a real, successfully committed response in one tab. The other
    // must shed authority while pending, and never replay if response is lost.
    const beforeLost = rotates;
    await run(a, "window.holdNextRotation=true; window.loseRotation=true; true");
    const lost = run(a, "controller.renewIfNeeded(3600).then(s=>s===null)");
    await poll("real rotation committed, response held", () => run(a, "window.rotationHeld===true"));
    assert.equal(await run(b, "controller.current()===null"), true);
    await run(a, "window.releaseRotation(); true");
    assert.equal(await lost, true);
    assert.equal(rotates, beforeLost + 1);
    assert.equal(await run(b, "controller.current()===null"), true);
    await b.send("Page.reload");
    await ready(b);
    assert.equal(await run(b, "controller.restore().then(s=>s===null)"), true);
    assert.equal(rotates, beforeLost + 1);

    // Explicit fresh login can replace a blocked family, not silently adopt it.
    const familyB = await run(a,
      "controller.login(" + JSON.stringify(proof(token, users[1])) + ").then(s=>s?.familyId)");
    assert.ok(familyB && familyB !== familyA);
    assert.equal(await run(b, "controller.logout()"), false);
    assert.equal(await run(b, "controller.restore().then(s=>s===null)"), true);
    await b.send("Page.reload");
    await ready(b);
    assert.equal(await run(b, "controller.restore().then(s=>s?.familyId)"), familyB);
    assert.equal(await run(a, "controller.logout()"), true);
    assert.equal(await run(b, "controller.current()===null"), true);
    const revoked = await pool.query(
      `SELECT f.revoked_at IS NOT NULL AS revoked,
          NOT EXISTS(SELECT 1 FROM cookie_identity.identity_sessions s
            WHERE s.refresh_family_id=f.id AND s.revoked_at IS NULL) AS access_revoked
       FROM cookie_identity.refresh_session_families f WHERE f.id=$1::uuid`,
      [familyB],
    );
    assert.deepEqual(revoked.rows, [{ revoked: true, access_revoked: true }]);
    await b.send("Page.reload");
    await ready(b);
    assert.equal(await run(b, "controller.restore().then(s=>s===null)"), true);
    assert.equal(await run(b,
      "localStorage.length===1 && localStorage.getItem('kuki-refresh-candidate-fence-v1')==='blocked' && sessionStorage.length===0 && !document.cookie.includes('__Host-kuki-refresh-candidate')"), true);
    console.log("PASS isolated real Chromium refresh: shared cookie/Web Locks, concurrent rotation, pending/response loss, reload fence, explicit account switch and exact family logout.");
  } finally {
    for (const cdp of clients) cdp.close();
    try {
      if (handle) await disposeBrowser(handle);
    } finally {
      try {
        await app.close();
        if (testIds.length) await transaction(async (client) => {
          await client.query("DELETE FROM cookie_identity.identity_sessions WHERE identity_id=ANY($1::uuid[])", [testIds]);
          await client.query(`DELETE FROM cookie_identity.refresh_session_credentials
            WHERE family_id IN (SELECT id FROM cookie_identity.refresh_session_families
                               WHERE identity_id=ANY($1::uuid[]))`, [testIds]);
          for (const table of ["refresh_session_families", "global_telegram_exchanges",
            "global_telegram_identities", "auth_security_events"]) {
            await client.query("DELETE FROM cookie_identity." + table + " WHERE identity_id=ANY($1::uuid[])", [testIds]);
          }
          await client.query("DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])", [testIds]);
        });
      } finally { await pool.end(); }
    }
  }
}

main().catch((error) => {
  // Never print HTTP bodies, proof, tokens or CDP payloads.
  console.error("Synthetic refresh browser smoke failed:", error.name);
  if (error.code === "ERR_ASSERTION") console.error("Assertion failed in refresh browser smoke");
  process.exitCode = 1;
});
