// Interactive, loopback-only real Cookie runtime for synthetic manual QA.
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
  openSync, closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import {
  browserBinary, freePort, poll, getLocal, createClient, requireDom,
} from "../apps/web/scripts/browser-smoke.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const folder = join(root, ".tmp", "manual-staging");
const settings = join(folder, "state.json");
const lockPath = join(folder, "run.lock");
const composeFile = join(root, "docker-compose.manual.yml");
const hex = () => randomBytes(32).toString("hex");

function browser() {
  const candidates = [
    process.env.COOKIE_BROWSER_BINARY,
    ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter(Boolean).flatMap((dir) => [
        join(dir, "Google/Chrome/Application/chrome.exe"),
        join(dir, "Microsoft/Edge/Application/msedge.exe"),
      ]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return candidates.find(existsSync) ?? browserBinary();
}

function proof(state, role = "owner") {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: role === "client" ? state.userId + 1000000000 : state.userId, first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k + "=" + v).join("\n");
  const key = createHmac("sha256", "WebAppData").update(state.botToken).digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function loadState() {
  if (!existsSync(settings)) {
    const state = {
      project: "cookie-manual-" + randomBytes(6).toString("hex"),
      dbPort: await freePort(),
      password: hex(),
      botToken: "123456789:" + randomBytes(24).toString("base64url"),
      secret: hex(),
      identityId: randomUUID(),
      setupKey: randomUUID(),
      userId: randomInt(100000000, 999999999),
      grantExpiry: new Date(Date.now() + 30 * 86400000).toISOString(),
    };
    writeFileSync(settings, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  }
  const state = JSON.parse(readFileSync(settings, "utf8"));
  if (!/^cookie-manual-[0-9a-f]{12}$/.test(state.project) ||
      !/^[0-9a-f]{64}$/.test(state.password) ||
      !/^[0-9a-f]{64}$/.test(state.secret) ||
      !/^123456789:[A-Za-z0-9_-]{32}$/.test(state.botToken) ||
      !Number.isInteger(state.dbPort) || state.dbPort < 1024 || state.dbPort > 65535 ||
      !Number.isInteger(state.userId) || state.userId < 1 ||
      !/^[0-9a-f-]{36}$/.test(state.identityId) ||
      !/^[0-9a-f-]{36}$/.test(state.setupKey) ||
      !Number.isFinite(Date.parse(state.grantExpiry))) {
    throw new Error("Invalid local state; refusing to start");
  }
  return state;
}

function compose(state, args) {
  const result = spawnSync("docker", [
    "compose", "-p", state.project, "-f", composeFile, ...args,
  ], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, COOKIE_MANUAL_DB_PORT: String(state.dbPort),
      COOKIE_MANUAL_DB_PASSWORD: state.password },
  });
  if (result.error || result.status !== 0) throw new Error("Docker Compose command failed");
}

async function seed(state, databaseUrl) {
  const { runMigrations } = await import("../dist/packages/platform-db/src/migrations.js");
  const { provisionOwnerWorkspace } = await import("../dist/packages/platform-identity/src/provision-owner-workspace.js");
  const { createTelegramMiniAppProofVerifier } = await import("../dist/packages/platform-identity/src/telegram-init-data.js");
  const { linkVerifiedTelegramOwner } = await import("../dist/packages/platform-identity/src/link-telegram-owner.js");
  const { issueStagingGrant } = await import("../dist/packages/domain-entitlement/src/staging.js");
  const { provisionStagingCustomer } = await import("../dist/packages/domain-customers/src/staging-customer.js");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await runMigrations(pool, resolve(root, "db/migrations"));
    await pool.query("INSERT INTO cookie_identity.identities(id) VALUES($1::uuid) ON CONFLICT (id) DO NOTHING", [state.identityId]);
    const owner = await provisionOwnerWorkspace(pool, {
      ownerIdentityId: state.identityId, idempotencyKey: state.setupKey,
      organizationName: "Тестовый салон Cookie", locationName: "Основной филиал",
      timeZone: "Europe/Moscow",
    });
    // Do not recreate a deliberately revoked link.
    const links = await pool.query(
      "SELECT id FROM cookie_identity.telegram_identity_links WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
      [owner.tenantId, state.identityId],
    );
    if (!links.rowCount) {
      const verifier = createTelegramMiniAppProofVerifier({ botToken: state.botToken, maxAgeSeconds: 300 });
      await linkVerifiedTelegramOwner(pool, verifier, Buffer.from(state.secret, "hex"), {
        tenantId: owner.tenantId, ownerIdentityId: state.identityId,
        rawInitData: proof(state), consentConfirmed: true,
      });
    }
    await provisionStagingCustomer(pool,
      createTelegramMiniAppProofVerifier({ botToken: state.botToken, maxAgeSeconds: 300 }),
      Buffer.from(state.secret, "hex"), {
        tenantId: owner.tenantId, rawInitData: proof(state, "client"), consentConfirmed: true,
      });
    const grants = await pool.query(
      "SELECT id FROM cookie_entitlement.staging_publication_grants WHERE tenant_id=$1::uuid",
      [owner.tenantId],
    );
    // Explicit synthetic fixture: five seats for 30 days; never auto-renew.
    if (!grants.rowCount && Date.parse(state.grantExpiry) > Date.now()) {
      await issueStagingGrant(pool, owner.tenantId, 5, state.grantExpiry);
    }
  } finally {
    await pool.end();
  }
}

function child(command, args, env) {
  const processHandle = spawn(command, args, { cwd: root, env, stdio: "ignore" });
  processHandle.once("error", () => { processHandle.startFailed = true; });
  return processHandle;
}

async function stop(handle) {
  if (!handle || handle.exitCode !== null || handle.signalCode !== null || !handle.pid) return;
  const exited = new Promise((done) => handle.once("exit", done));
  handle.kill("SIGTERM");
  if (!(await Promise.race([exited.then(() => true), pause(4000).then(() => false)]))) {
    handle.kill("SIGKILL");
    await Promise.race([exited, pause(1000)]);
  }
}

async function signIn(cdp, origin, state, role = "owner") {
  const path = role === "client" ? "/?surface=customer-staging" : "/";
  const source = "if(location.href===" + JSON.stringify(origin + path) +
    "){window.Telegram={WebApp:{initData:" + JSON.stringify(proof(state, role)) + "}}}";
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  try {
    const navigation = await cdp.send("Page.navigate", { url: origin + path });
    if (navigation.errorText) throw new Error("Browser navigation failed");
    await requireDom(cdp, "verified " + role + " workspace", role === "client"
      ? "document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.innerText==='Вход клиента подтверждён'"
      : "document.querySelector('.verified-owner-shell[data-cookie-mode=api] .sidebar')");
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

async function main() {
  const command = process.argv[2] ?? "start";
  if (!["start", "stop"].includes(command) || process.argv.length > 3) throw new Error("Use start or stop");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (command === "stop" && !existsSync(settings)) return;
  const lock = openSync(lockPath, "wx", 0o600);
  let state, api, chrome, profile, cdp, input;
  const closeInput = () => input?.close();
  try {
    state = await loadState();
    if (command === "stop") {
      compose(state, ["stop"]);
      return;
    }
    if (!existsSync(join(root, "dist/apps/api/src/main.js")) ||
        !existsSync(join(root, "apps/web/dist/index.html"))) throw new Error("Run pnpm build:runtime first");
    const binary = browser();
    compose(state, ["up", "-d", "--wait"]);
    const databaseUrl = "postgresql://cookie:" + state.password +
      "@127.0.0.1:" + state.dbPort + "/cookie_manual";
    await seed(state, databaseUrl);
    const port = await freePort();
    const origin = "http://127.0.0.1:" + port;
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(COOKIE_|DATABASE_URL$|PG|NODE_OPTIONS$)/i.test(key)));
    api = child(process.execPath, ["dist/apps/api/src/main.js"], {
      ...env, HOST: "127.0.0.1", PORT: String(port),
      DATABASE_URL: databaseUrl, COOKIE_WEB_DIST: join(root, "apps/web/dist"),
      COOKIE_TELEGRAM_AUTH_MODE: "enabled",
      COOKIE_STAGING_PUBLICATION_MODE: "enabled",
      COOKIE_STAGING_CUSTOMER_BOOKING_MODE: "enabled",
      COOKIE_PUBLIC_ORIGIN: "https://cookie-manual.invalid",
      COOKIE_TELEGRAM_BOT_TOKEN: state.botToken,
      COOKIE_TELEGRAM_USER_HMAC_SECRET: state.secret,
    });
    await poll("compiled API readiness", async () => {
      if (api.startFailed || api.exitCode !== null) return false;
      return (await getLocal(origin + "/health/ready")).status === 200;
    }, 18000);
    profile = mkdtempSync(join(tmpdir(), "cookie-manual-chrome-"));
    chrome = child(binary, [
      "--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "about:blank",
    ], process.env);
    const target = await poll("isolated Chromium DevTools", async () => {
      if (chrome.startFailed || chrome.exitCode !== null) return false;
      const debuggingPort = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (!Number.isInteger(debuggingPort) || debuggingPort < 1 || debuggingPort > 65535) return false;
      const response = await getLocal("http://127.0.0.1:" + debuggingPort + "/json/list");
      const page = JSON.parse(response.text).find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl && new URL(page.webSocketDebuggerUrl).hostname === "127.0.0.1") return page;
      return false;
    }, 18000);
    cdp = createClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await signIn(cdp, origin, state);
    console.log("Real Cookie: " + origin + " — use the opened isolated browser.");
    console.log("Synthetic records only. owner / client = switch role; Enter = fresh login; demo = isolated preview; Ctrl+C = exit. DB retained.");
    input = createInterface({ input: process.stdin, output: process.stdout });
    input.on("SIGINT", closeInput);
    process.on("SIGINT", closeInput);
    process.on("SIGTERM", closeInput);
    api.once("exit", closeInput);
    chrome.once("exit", closeInput);
    let role = "owner";
    for await (const line of input) {
      const command = line.trim().toLowerCase();
      if (command && !["owner", "client", "demo"].includes(command)) {
        console.log("Use owner, client, demo or Enter.");
        continue;
      }
      try {
        if (command === "demo") {
          await cdp.send("Page.navigate", { url: origin + "/demo" });
          await requireDom(cdp, "explicit demo", "document.querySelector('[data-cookie-mode=mock]')");
          continue;
        }
        if (command) role = command;
        await signIn(cdp, origin, state, role);
        console.log("Signed in as " + role + ".");
      } catch {
        console.error("Sign-in was not confirmed; check local runtime and browser.");
      }
    }
  } finally {
    process.off("SIGINT", closeInput);
    process.off("SIGTERM", closeInput);
    input?.close();
    cdp?.close();
    await stop(chrome);
    await stop(api);
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

main().catch(() => {
  console.error("Local staging failed. Check Node 26, Docker, Chrome/Edge, build:runtime and local ports. No credentials logged.");
  process.exitCode = 1;
});
