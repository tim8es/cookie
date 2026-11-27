// Interactive, loopback-only real Cookie runtime for synthetic manual QA.
import assert from "node:assert/strict";
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
  evaluate, fill, submitValidForm, checkWidth,
} from "../apps/web/scripts/browser-smoke.mjs";

import { isLocalStagingProject, resolveLocalStagingMode } from "./local-staging-mode.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Disposable demo and CI never read/write the operator's persistent QA state.
const mode = resolveLocalStagingMode(process.argv.slice(2), process.env.CI);
const { verification, disposable, demo } = mode;
let localStagingPhase = "initialization";
const parent = join(root, ".tmp");
if (disposable) mkdirSync(parent, { recursive: true, mode: 0o700 });
const folder = disposable
  ? mkdtempSync(join(parent, mode.folderPrefix))
  : join(parent, mode.folderPrefix);
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
      project: mode.projectPrefix + randomBytes(6).toString("hex"),
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
  if (!isLocalStagingProject(mode, state.project) ||
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
      organizationName: demo ? "Демо-салон kuki" : "Тестовый салон Cookie", locationName: "Основной филиал",
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
    return { tenantId: owner.tenantId, locationId: owner.locationId };
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
    if (role !== "client") await pressButton(cdp, "Я представляю бизнес");
    await pressButton(cdp, "Войти через Telegram");
    await requireDom(cdp, "verified " + role + " workspace", role === "client"
      ? "document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.innerText==='Вход клиента подтверждён'"
      : "document.querySelector('.verified-owner-shell[data-cookie-mode=api] .sidebar')");
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

// Identical browser/DB contract for disposable QA and true demo verification.
// Use the existing real form and API, never a second implementation.
async function verifySharedCatalog(cdp, databaseUrl, tenantId, example) {
  const marker = "Synthetic shared runtime service";
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const read = async () => (await pool.query(
      "SELECT display_name, duration_minutes, base_price_kopecks::text AS price, active FROM cookie_catalog.services WHERE tenant_id=$1::uuid",
      [tenantId],
    )).rows;
    const baseline = await read();
    assert.deepEqual(baseline, example ? [{
      display_name: example.name, duration_minutes: 60, price: example.price, active: true,
    }] : []);
    await requireDom(cdp, "actual owner service form",
      "document.querySelector('.owner-form input') && " + (example
        ? "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(example.name) + ")"
        : "document.querySelector('.empty-mini')"));
    for (const width of [1280, 375, 320]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width, height: 812, deviceScaleFactor: 1, mobile: width < 600,
      });
      await checkWidth(cdp, "shared runtime service form " + width + "px");
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await fill(cdp, ".owner-form input:not([type=number])", marker);
    await evaluate(cdp, "(() => {const n=document.querySelectorAll('.owner-form input[type=number]');n[0].value='45';n[0].dispatchEvent(new Event('input',{bubbles:true}));n[1].value='1200';n[1].dispatchEvent(new Event('input',{bubbles:true}));})()");
    await fill(cdp, ".owner-form input[name=post-service-buffer-minutes]", "15");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "confirmed real catalog service",
      "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(marker) + ") && document.querySelector('.list-items')?.innerText.includes('Буфер: 15 мин')");
    const stored = await read();
    assert.equal(stored.length, baseline.length + 1);
    assert.deepEqual(stored.filter((item) => item.display_name === marker), [{
      display_name: marker, duration_minutes: 45, price: "120000", active: false,
    }]);
    assert.deepEqual(stored.filter((item) => item.display_name !== marker), baseline);
    const buffer = await pool.query(
      "SELECT post_service_buffer_minutes FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND display_name=$2",
      [tenantId, marker],
    );
    assert.deepEqual(buffer.rows, [{ post_service_buffer_minutes: 15 }]);
    const receipt = await pool.query(
      "SELECT count(*)::int AS count FROM cookie_catalog.service_create_receipts WHERE tenant_id=$1::uuid",
      [tenantId],
    );
    assert.equal(receipt.rows[0]?.count, baseline.length + 1);
  } finally {
    await pool.end();
  }
  return marker;
}

async function pressButton(cdp, label) {
  const button = "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===" + JSON.stringify(label) + "&&!b.disabled&&b.getClientRects().length)";
  await requireDom(cdp, label, button);
  await evaluate(cdp, button + ".click()");
}

async function logoutVerified(cdp) {
  const ownerMenu = "[...document.querySelectorAll('.workspace-account .rhythm-popover-trigger')].find(b=>b.getClientRects().length)";
  if (await evaluate(cdp, "Boolean(document.querySelector('.real-owner-nav'))")) {
    if (!await evaluate(cdp, "Boolean(" + ownerMenu + ")")) {
      await evaluate(cdp, "document.querySelector('.real-owner-nav .mobile-nav button[aria-controls=mobile-more-panel]')?.click()");
    }
    await requireDom(cdp, "workspace account menu", "Boolean(" + ownerMenu + ")");
    await evaluate(cdp, "(" + ownerMenu + ").click()");
  }
  await pressButton(cdp, "Выйти");
  await requireDom(cdp, "server-confirmed logout",
    "document.body.innerText.includes('Вы вышли') && !document.querySelector('.real-owner-nav')");
}

// Check the seeded offer via the real customer surface and persist a real booking.
async function verifyDemoBooking(cdp, databaseUrl, tenantId, example) {
  localStagingPhase = "select synthetic client booking offer";
  const panel = '[aria-label="Клиентская витрина staging"]';
  const service = "document.querySelector(" + JSON.stringify(panel + " [data-component=ChoiceList] button") + ")";
  await requireDom(cdp, "seeded service option", service + " && !" + service + ".disabled");
  await evaluate(cdp, service + ".click()");
  await pressButton(cdp, "Продолжить");
  for (const label of ["Филиал", "Мастер"]) {
    const selector = JSON.stringify(panel + ' [data-component="ChoiceList"][aria-label="' + label + '"] button[data-component="ChoiceRow"]');
    const choice = "document.querySelector(" + selector + ")";
    await requireDom(cdp, "seeded catalog option " + label, "document.querySelectorAll(" + selector + ").length===1 && !" + choice + ".disabled");
    await evaluate(cdp, choice + ".click()");
    await requireDom(cdp, "selected catalog option " + label, choice + "?.getAttribute('aria-pressed')==='true'");
  }
  await pressButton(cdp, "Продолжить");
  await requireDom(cdp, "date selection", "document.querySelector(" + JSON.stringify(panel + " input[type=date]") + ")?.disabled===false");
  await fill(cdp, panel + " input[type=date]", example.date, "change");
  await pressButton(cdp, "Найти свободное время");
  const slot = "document.querySelector(" + JSON.stringify(panel + " .customer-slot-choice") + ")";
  await requireDom(cdp, "real available slot", slot);
  await evaluate(cdp, slot + ".click()");
  await pressButton(cdp, "Продолжить");
  localStagingPhase = "create synthetic booking from client UI";
  await pressButton(cdp, "Записаться");
  await requireDom(cdp, "server-confirmed demo booking", "document.querySelector(" + JSON.stringify(panel) + ")?.innerText.includes('Создание записи подтверждено')");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      "SELECT id::text, status, staff_id::text, service_id::text, location_id::text, price_kopecks_snapshot::text AS price FROM cookie_booking.bookings WHERE tenant_id=$1::uuid",
      [tenantId],
    );
    assert.equal(result.rowCount, 1);
    const { id, ...booking } = result.rows[0];
    assert.deepEqual(booking, { status: "Confirmed", staff_id: example.staffId,
      service_id: example.serviceId, location_id: example.locationId, price: example.price });
    await requireDom(cdp, "demo booking in client history", "document.querySelector('[aria-label=\\\"Мои записи\\\"]')?.innerText.includes(" + JSON.stringify(id) + ")");
    assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0);
    console.log("PASS seeded demo: verified client offer and PostgreSQL-backed booking");
    return id;
  } finally { await pool.end(); }
}

async function verifyDemoCalendar(cdp, example, expectedStatus) {
  localStagingPhase = "verify owner calendar with status " + expectedStatus;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await pressButton(cdp, "Календарь");
  const select = "document.querySelector('.owner-calendar select')";
  await requireDom(cdp, "demo owner calendar branch ready",
    select + "?.value===" + JSON.stringify(example.locationId) +
      " && document.querySelector('.owner-calendar input[type=date]')?.disabled===false");
  await fill(cdp, ".owner-calendar input[type=date]", example.date, "change");
  const rows = "document.querySelector('[aria-label=\\\"Записи за выбранный период\\\"]')";
  const expected = rows + "?.innerText.includes(" + JSON.stringify(example.name) + ") && " +
    rows + "?.querySelectorAll('.schedule-summary').length===1 && " +
    rows + "?.querySelector('.status-pill')?.innerText.includes(" + JSON.stringify(expectedStatus) + ")";
  await requireDom(cdp, "demo owner calendar: " + expectedStatus, expected);
  await pressButton(cdp, "Неделя");
  await requireDom(cdp, "same demo booking in weekly calendar", expected);
  for (const [width, height] of [[320,568],[375,812],[1280,800]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: width < 600,
    });
    await checkWidth(cdp, "demo owner calendar " + expectedStatus + " " + width + "px");
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

async function verifyDemoBookingLifecycle(cdp, origin, state, databaseUrl, tenantId, example) {
  // Both roles use their own ordinary verified session and the exact same
  // compiled application. Every mutation goes through the actual browser UI.
  localStagingPhase = "create synthetic client booking";
  const id = await verifyDemoBooking(cdp, databaseUrl, tenantId, example);
  localStagingPhase = "logout client after booking";
  await logoutVerified(cdp);
  localStagingPhase = "authenticate owner for confirmed calendar";
  await signIn(cdp, origin, state, "owner");
  await verifyDemoCalendar(cdp, example, "Подтверждена");
  localStagingPhase = "logout owner before client cancellation";
  await logoutVerified(cdp);
  localStagingPhase = "authenticate client to cancel booking";
  await signIn(cdp, origin, state, "client");
  const history = "document.querySelector('[aria-label=\\\"Мои записи\\\"]')";
  await requireDom(cdp, "same booking after new client authentication",
    history + "?.innerText.includes(" + JSON.stringify(id) + ")");
  localStagingPhase = "cancel synthetic booking from client UI";
  await pressButton(cdp, "Отменить запись");
  await pressButton(cdp, "Подтвердить отмену");
  await requireDom(cdp, "client cancellation on real runtime",
    history + "?.innerText.includes('Отменена клиентом')");
  localStagingPhase = "verify persisted client cancellation";
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      "SELECT id::text, status, price_kopecks_snapshot::text AS price FROM cookie_booking.bookings WHERE tenant_id=$1::uuid",
      [tenantId],
    );
    assert.deepEqual(result.rows, [{ id, status: "CancelledByClient", price: example.price }]);
  } finally { await pool.end(); }
  assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0);
  localStagingPhase = "logout client after cancellation";
  await logoutVerified(cdp);
  localStagingPhase = "authenticate owner to verify cancelled calendar";
  await signIn(cdp, origin, state, "owner");
  await verifyDemoCalendar(cdp, example, "Отменена клиентом");
  await logoutVerified(cdp);
  console.log("PASS seeded demo lifecycle: client booking, owner calendar, client cancellation, owner calendar, PostgreSQL, role logout and fresh login");
}

async function main() {
  const { command } = mode;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (command === "stop" && !existsSync(settings)) return;
  const lock = openSync(lockPath, "wx", 0o600);
  let state, api, chrome, profile, cdp, input;
  let interrupted = false;
  let composeAttempted = false;
  const closeInput = () => { interrupted = true; input?.close(); };
  const checkInterrupted = () => {
    if (interrupted) throw new Error("Launch interrupted");
  };
  process.on("SIGINT", closeInput);
  process.on("SIGTERM", closeInput);
  try {
    state = await loadState();
    localStagingPhase = "validate compiled runtime and browser";
    if (command === "stop") {
      compose(state, ["stop"]);
      return;
    }
    if (!existsSync(join(root, "dist/apps/api/src/main.js")) ||
        !existsSync(join(root, "apps/web/dist/index.html"))) throw new Error("Run pnpm build:runtime first");
    const { parseStagingCancellationCutoff } = await import("../dist/apps/api/src/staging-customer-cancellation-http.js");
    // Temporary operator-only staging input. No product default: #285 tracks tenant policy.
    const cutoff = parseStagingCancellationCutoff(process.env.COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES);
    const binary = browser();
    checkInterrupted();
    composeAttempted = true;
    localStagingPhase = "start disposable PostgreSQL";
    compose(state, ["up", "-d", "--wait"]);
    const databaseUrl = "postgresql://cookie:" + state.password +
      "@127.0.0.1:" + state.dbPort + "/cookie_manual";
    // Container health can precede TCP readiness during initial DB initialization.
    const readiness = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000 });
    try {
      await poll("dedicated PostgreSQL TCP readiness", async () => {
        const result = await readiness.query("SELECT current_database() AS name");
        return result.rows[0]?.name === "cookie_manual";
      }, 30000);
    } finally { await readiness.end(); }
    checkInterrupted();
    localStagingPhase = "seed synthetic identities and workspace";
    const workspace = await seed(state, databaseUrl);
    const { tenantId } = workspace;
    checkInterrupted();
    const port = await freePort();
    const origin = "http://127.0.0.1:" + port;
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(COOKIE_|DATABASE_URL$|PG|NODE_OPTIONS$)/i.test(key)));
    localStagingPhase = "start compiled API";
    api = child(process.execPath, ["dist/apps/api/src/main.js"], {
      ...env, HOST: "127.0.0.1", PORT: String(port),
      DATABASE_URL: databaseUrl, COOKIE_WEB_DIST: join(root, "apps/web/dist"),
      COOKIE_TELEGRAM_AUTH_MODE: "enabled",
      COOKIE_TELEGRAM_SELF_REGISTRATION_MODE: "enabled",
      COOKIE_STAGING_PUBLICATION_MODE: "enabled",
      COOKIE_STAGING_CUSTOMER_BOOKING_MODE: "enabled",
      ...(cutoff === undefined ? {} : { COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES: String(cutoff) }),
      COOKIE_PUBLIC_ORIGIN: "https://cookie-manual.invalid",
      COOKIE_TELEGRAM_BOT_TOKEN: state.botToken,
      COOKIE_TELEGRAM_USER_HMAC_SECRET: state.secret,
    });
    await poll("compiled API readiness", async () => {
      if (api.startFailed || api.exitCode !== null) return false;
      return (await getLocal(origin + "/health/ready")).status === 200;
    }, 18000);
    checkInterrupted();
    let example = null;
    if (demo) {
      const { seedDemoCatalog } = await import("./local-demo-seed.mjs");
      example = await seedDemoCatalog(origin, proof(state), workspace);
    }
    checkInterrupted();
    localStagingPhase = "launch isolated Chromium";
    profile = mkdtempSync(join(tmpdir(), "cookie-manual-chrome-"));
    chrome = child(binary, [
      "--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking",
      ...(verification ? ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"] : []),
      "about:blank",
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
    const cancellationResponses = [];
    if (verification) {
      await cdp.send("Network.enable");
      cdp.onEvent("Network.responseReceived", ({ response }) => {
        if (response.url.startsWith(origin + "/v1/") && response.url.endsWith("/staging-customer-cancellation/capability")) cancellationResponses.push(response.status);
      });
    }
    checkInterrupted();
    localStagingPhase = "authenticate synthetic owner";
    await signIn(cdp, origin, state);
    checkInterrupted();
    if (verification) {
      localStagingPhase = "verify authenticated owner catalog";
      const marker = await verifySharedCatalog(cdp, databaseUrl, tenantId, example);
      localStagingPhase = "authenticate synthetic client";
      await signIn(cdp, origin, state, "client");
      await poll("actual cancellation capability", () => cancellationResponses.includes(cutoff === undefined ? 404 : 200));
      const policyText = cutoff === undefined ? "Отмена в тестовом режиме недоступна." : "более чем " + cutoff + " мин.";
      await requireDom(cdp, "explicit cancellation cutoff (no implicit default)", "document.querySelector(\'[aria-label=\\\"Мои записи\\\"]\')?.innerText.includes(" + JSON.stringify(policyText) + ")");
      await requireDom(cdp, "actual client workspace without owner navigation", "document.querySelector(\'[aria-label=\\\"Клиентский вход staging\\\"]\') && !document.querySelector(\'.real-owner-nav\')");
      if (example) {
        if (cutoff === undefined) throw new Error("Demo lifecycle verification requires explicit synthetic cutoff");
        localStagingPhase = "verify synthetic booking lifecycle";
        await verifyDemoBookingLifecycle(cdp, origin, state, databaseUrl, tenantId, example);
      }
      localStagingPhase = "verify unauthenticated runtime and legacy-route closure";
      await cdp.send("Page.navigate", { url: origin + "/" });
      await requireDom(cdp, "no owner authorization without fresh signed proof",
        "document.querySelector('[data-cookie-mode=api] .identity-auth-page') && !document.querySelector('.verified-owner-shell') && !document.querySelector('.sidebar')");
      for (const path of ["/demo", "/demo/", "/demo?browser-smoke=1", "/demo/example"]) {
        const legacy = await getLocal(origin + path);
        assert.equal(legacy.status, 404, "Legacy fixture must not be served by the real runtime");
        assert.doesNotMatch(legacy.text, /<html/i);
      }
      localStagingPhase = "re-authenticate synthetic owner";
      await signIn(cdp, origin, state, "owner");
      await requireDom(cdp, "shared catalog survives role switch and fresh authentication",
        "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(marker) + ")");
      assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0,
        "No browser-local mock, pending mutation or session data remains");
      console.log("PASS shared " + (demo ? "demo" : "QA") + " runtime catalog: browser write, real DB/receipt, role switch, fail-closed entry, three viewport widths");
      console.log("PASS actual local launcher: dedicated PostgreSQL, migrations, compiled runtime, signed owner/client and demo isolation");
      return;
    }
    console.log((demo ? "kuki demo (synthetic, disposable): " : "Real kuki: ") + origin + " — use the opened isolated browser.");
    console.log(cutoff === undefined ? "Cancellation disabled: COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES is unset." : "Explicit synthetic cancellation cutoff: " + cutoff + " minutes.");
    if (example) console.log("Sample service and published shift on " + example.date + ". Switch to client to book.");
    console.log(demo
      ? "Synthetic records only. owner / client = switch role; Enter = fresh login; Ctrl+C = exit and remove this demo database. Relaunch for a fresh demo."
      : "Synthetic records only. owner / client = switch role; Enter = fresh login; Ctrl+C = exit. DB retained. Use pnpm demo:local separately for disposable demo.");
    input = createInterface({ input: process.stdin, output: process.stdout });
    input.on("SIGINT", closeInput);
    api.once("exit", closeInput);
    chrome.once("exit", closeInput);
    let role = "owner";
    for await (const line of input) {
      const command = line.trim().toLowerCase();
      if (command && !["owner", "client"].includes(command)) {
        console.log("Use owner, client or Enter. Start a disposable demo separately with pnpm demo:local.");
        continue;
      }
      try {
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
    try {
      try { await stop(chrome); } finally { await stop(api); }
      if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } finally {
      let cleaned = false;
      try {
        // Only an explicitly disposable, freshly generated local profile owns its volume.
        if (disposable && state && composeAttempted) {
          if (!isLocalStagingProject(mode, state.project)) throw new Error("Refusing cleanup of an unrelated project");
          compose(state, ["down", "-v"]);
        }
        cleaned = true;
      } finally {
        closeSync(lock);
        rmSync(lockPath, { force: true });
        if (disposable && cleaned) rmSync(folder, { recursive: true, force: true });
        if (disposable && !cleaned) {
          console.error("Disposable cleanup failed; private state retained at " + folder + " for manual recovery.");
        }
      }
    }
  }
}

main().catch(() => {
  console.error(`Local staging failed during ${localStagingPhase}. Check Node 26, Docker, Chrome/Edge, build:runtime and local ports. No credentials logged.`);
  process.exitCode = 1;
});
