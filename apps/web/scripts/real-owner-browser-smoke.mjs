// Real compiled owner workflow over loopback HTTP + actual PostgreSQL.
// No mock API or verifier; a synthetic Telegram initData proof is generated
// using an ephemeral test-only HMAC key. Never run this against real data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import {
  browserBinary, freePort, poll, getLocal, createClient, evaluate,
  requireDom, fill, submitValidForm, checkWidth, checkLabeledControls,
} from "./browser-smoke.mjs";
import { startChromiumWithRetry } from "../../../scripts/f1-chromium-startup.mjs";
import { verifyOwnerBookingDetail } from "./owner-booking-detail-smoke.mjs";

import { issueStagingGrant } from "../../../dist/packages/domain-entitlement/src/staging.js";
import { provisionStagingCustomer } from "../../../dist/packages/domain-customers/src/staging-customer.js";
import { runMigrations } from "../../../dist/packages/platform-db/src/migrations.js";
import { provisionOwnerWorkspace } from "../../../dist/packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../dist/packages/platform-identity/src/telegram-init-data.js";
import { linkVerifiedTelegramOwner } from "../../../dist/packages/platform-identity/src/link-telegram-owner.js";
import { runSqlTransaction } from "../../../dist/packages/platform-db/src/transaction.js";
import { prepareLegacyTelegramMigration } from "../../../dist/packages/platform-identity/src/legacy-telegram-migration-preparation.js";
import { activateLegacyTelegramMigration } from "../../../dist/packages/platform-identity/src/legacy-telegram-migration-activation.js";

function isolatedDatabase() {
  if (process.env.CI !== "true" || !process.env.TEST_DATABASE_URL) {
    throw new Error("Requires CI=true and dedicated TEST_DATABASE_URL");
  }
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.pathname !== "/cookie_ci") {
    throw new Error("Refusing real-owner smoke outside loopback cookie_ci");
  }
  return process.env.TEST_DATABASE_URL;
}

function signedProof(botToken, userId) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: userId, first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => name + "=" + value).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function seed(pool, botToken, userHashSecret, userId) {
  await runMigrations(pool, resolve("db/migrations"));
  const identityId = randomUUID();
  await pool.query("INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)", [identityId]);
  const owner = await provisionOwnerWorkspace(pool, {
    ownerIdentityId: identityId,
    organizationName: "Synthetic browser salon",
    locationName: "Synthetic Central",
    timeZone: "Europe/Moscow",
    idempotencyKey: randomUUID(),
  });
  const verify = createTelegramMiniAppProofVerifier({ botToken, maxAgeSeconds: 300 });
  await linkVerifiedTelegramOwner(pool, verify, userHashSecret, {
    tenantId: owner.tenantId,
    ownerIdentityId: identityId,
    rawInitData: signedProof(botToken, userId),
    consentConfirmed: true,
  });
  return { ...owner, identityId };
}

async function startServer(env, origin) {
  // Main is the deployment entrypoint. Do not print process logs: signed proof
  // and ephemeral credentials must never be included in public CI output.
  const child = spawn(process.execPath, ["dist/apps/api/src/main.js"], {
    env, stdio: "ignore",
  });
  try {
    await poll("compiled API readiness", async () => {
      if (child.exitCode !== null) throw new Error("Compiled API exited");
      const response = await getLocal(origin + "health/ready");
      return response.status === 200 && JSON.parse(response.text).status === "ready";
    }, 18000);
    return child;
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const ended = await Promise.race([exited.then(() => true), pause(4000).then(() => false)]);
  if (!ended) {
    child.kill("SIGKILL");
    await exited;
    throw new Error("Compiled API did not shut down gracefully");
  }
}

async function stopBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const closed = new Promise((done) => child.once("close", done));
  child.kill("SIGTERM");
  await Promise.race([closed, pause(800)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([closed, pause(800)]);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error("Chromium child could not be reaped");
}

async function button(cdp, label) {
  // Use the same reachable desktop/mobile owner navigation as the user.
  const ownerScreens = { "Обзор": "home", "Услуги": "services", "Мастера": "staff", "Филиалы": "locations", "Расписание": "schedule", "Календарь": "calendar", "Оформление": "appearance", "Онлайн-запись": "booking" };
  const target = ownerScreens[label];
  if (target && await evaluate(cdp, "Boolean(document.querySelector(\'.real-owner-nav\'))")) {
    const selector = JSON.stringify(".real-owner-nav button[data-screen=" + target + "]");
    const found = await evaluate(cdp, "(() => {const find=()=>[...document.querySelectorAll(" + selector + ")].find(el=>el.getClientRects().length&&!el.disabled);const b=find();if(b){b.click();return true;}const more=document.querySelector(\'.real-owner-nav .mobile-nav button[aria-controls=mobile-more-panel]\');if(more?.getClientRects().length){more.click();return false;}return false;})()");
    if (!found) {
      await requireDom(cdp, "mobile navigation section " + target, "[...document.querySelectorAll(" + selector + ")].some(el=>el.getClientRects().length&&!el.disabled)");
      await evaluate(cdp, "[...document.querySelectorAll(" + selector + ")].find(el=>el.getClientRects().length&&!el.disabled).click()");
    }
    return;
  }
  if ((label === "Выйти" || label === "Сменить кабинет") &&
      await evaluate(cdp, "Boolean(document.querySelector('.real-owner-nav'))")) {
    const findTrigger = "[...document.querySelectorAll('.workspace-account button.rhythm-popover-trigger')].find(el=>el.getClientRects().length)";
    if (!await evaluate(cdp, "Boolean(" + findTrigger + ")")) {
      await evaluate(cdp, "document.querySelector('.real-owner-nav .mobile-nav button[aria-controls=mobile-more-panel]').click()");
    }
    await requireDom(cdp, "workspace account trigger", "Boolean(" + findTrigger + ")");
    await evaluate(cdp, "(" + findTrigger + ").click()");
  }
  // Authentication may be restoring on mount. Await the enabled control,
  // not merely its presence, before attempting the user's next action.
  if (label === "Я представляю бизнес" || label === "Войти через Telegram") {
    await requireDom(cdp, "auth control ready: " + label,
      "[...document.querySelectorAll('button')].some(el=>el.getClientRects().length&&!el.disabled&&el.textContent.trim()===" + JSON.stringify(label) + ")");
  }
  // Actual rendered button + native click, no direct function invocation.
  const clicked = await evaluate(cdp,
    "(() => {const b=[...document.querySelectorAll('button')].find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.trim()===" +
    JSON.stringify(label) + ");if(!b)return false;b.click();return true})()");
  assert.equal(clicked, true, "Missing enabled button: " + label);
}

async function viewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
}

async function load(cdp, origin, proof, previous) {
  if (previous) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous });
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    // Test harness provides only the SDK input shape, not user claims or
    // bearer/session state; the real server independently verifies HMAC.
    source: "window.Telegram={WebApp:{initData:" + JSON.stringify(proof) + "}};window.__cookieTestClockMs=0;const realNow=Date.now.bind(Date);Date.now=()=>realNow()+window.__cookieTestClockMs;",
  });
  await cdp.send("Page.navigate", { url: origin });
  return identifier;
}

async function enterTelegram(cdp, role) {
  if (role === "business") {
    await requireDom(cdp, "business role choice", "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Я представляю бизнес')");
    await button(cdp, "Я представляю бизнес");
  }
  await requireDom(cdp, "single Telegram-only login action", "!document.body.innerText.includes('email и пароль') && [...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Войти через Telegram').length===1");
  await button(cdp, "Войти через Telegram");
}

async function loadAndEnterTelegram(cdp, origin, proof, previous, role) {
  const script = await load(cdp, origin, proof, previous);
  await enterTelegram(cdp, role);
  return script;
}

// Read-only navigation measurements on this isolated synthetic CI workspace.
// Measure browser time, not CDP/polling latency. Report no URLs, IDs or payloads.
async function benchmarkOwnerNavigation(cdp) {
  await viewport(cdp, 1280, 800);
  const screens = [
    ["services", "/services", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service') && !document.querySelector('.owner-form button[type=submit]')?.disabled"],
    ["calendar", "/calendar", "document.querySelector('.empty-mini')?.innerText.includes('За выбранный период записей нет') && document.querySelector('.owner-calendar input[type=date]')?.disabled===false"],
    ["schedule", "/schedule", "document.querySelector('.schedule-summary')?.innerText.includes('Synthetic E2E Staff') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Обновить'&&!b.disabled)"],
    ["appearance", "/appearance", "document.querySelector('.brand-editor') && document.querySelector('.brand-presets button.active')?.textContent.includes('Ботаника')"],
  ];
  const samples = new Map(screens.map(([key]) => [key, []]));
  // Warm each route once; then measure 20 round trips through all four screens.
  for (let round = 0; round <= 20; round++) {
    for (const [key, path, condition] of screens) {
      const selector = ".real-owner-nav button[data-screen=" + key + "]";
      const sample = await evaluate(cdp, `(async()=> {
        const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find(b=>b.getClientRects().length&&!b.disabled);
        if(!button || location.pathname===${JSON.stringify(path)}) throw new Error("benchmark navigation precondition");
        performance.clearResourceTimings();
        const begin = performance.now();
        let routeMs;
        button.click();
        while(performance.now()-begin<10000){
          if(routeMs===undefined && location.pathname===${JSON.stringify(path)} &&
            document.querySelector(${JSON.stringify(selector+"[aria-current=page]")})) routeMs=performance.now()-begin;
          if(routeMs!==undefined && (${condition})){
            const dataMs=performance.now()-begin;
            const requests=performance.getEntriesByType("resource")
              .filter(r=>r.startTime>=begin && r.responseEnd>0 && new URL(r.name).origin===location.origin && new URL(r.name).pathname.startsWith("/v1/"))
              .map(r=>({ms:r.duration,ttfb:r.responseStart-r.startTime}));
            return {routeMs,dataMs,requests};
          }
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        return {timeout:true,routeReady:routeMs!==undefined};
      })()`);
      assert.ok(!sample.timeout, "Benchmark section did not settle: " + key + ", routeReady=" + sample.routeReady);
      assert.ok(Number.isFinite(sample.dataMs) && sample.requests.length > 0, "Missing navigation timing: " + key);
      if (round > 0) samples.get(key).push(sample);
    }
  }
  function stats(values) {
    assert.ok(values.length > 0);
    const sorted = [...values].sort((a,b)=>a-b);
    const percentile = p => Math.round(sorted[Math.ceil(p*sorted.length)-1]*10)/10;
    return {n:sorted.length,p50:percentile(0.5),p95:percentile(0.95)};
  }
  for (const [screen, rows] of samples) {
    const requests = rows.flatMap(r=>r.requests);
    console.log("PERF_OWNER_CI " + JSON.stringify({
      profile:"loopback-pg-ci-1280x800-warm",screen,
      routeMs:stats(rows.map(r=>r.routeMs)),
      dataMs:stats(rows.map(r=>r.dataMs)),
      apiMs:stats(requests.map(r=>r.ms)),
      apiTtfbMs:stats(requests.map(r=>r.ttfb)),
      apiCount:stats(rows.map(r=>r.requests.length)),
    }));
  }
  await viewport(cdp, 375, 812);
}

async function waitForm(cdp, name) {
  await requireDom(cdp, name, "document.querySelector('.owner-form input') && document.querySelector('h1')");
}

async function assertStored(pool, owner, locationId) {
  const result = await pool.query(
    `SELECT
       s.id::text AS service_id, s.display_name AS service_name,
       s.duration_minutes, s.post_service_buffer_minutes, s.base_price_kopecks::text AS price, s.active AS service_active, s.draft_revision,
       p.id::text AS staff_id, p.display_name AS staff_name, p.position_title,
       p.active AS staff_active, p.bookable, la.active AS location_active,
       sa.active AS assignment_active, la.location_id::text AS location_id
       FROM cookie_catalog.services s
       JOIN cookie_staff.service_assignments sa ON sa.tenant_id=s.tenant_id AND sa.service_id=s.id
       JOIN cookie_staff.staff_profiles p ON p.tenant_id=sa.tenant_id AND p.id=sa.staff_id
       JOIN cookie_staff.location_assignments la ON la.tenant_id=sa.tenant_id
         AND la.staff_id=sa.staff_id AND la.location_id=sa.location_id
      WHERE s.tenant_id=$1::uuid`,
    [owner.tenantId],
  );
  assert.equal(result.rowCount, 1, "Expected exactly one joined Service/Staff/Location");
  const row = result.rows[0];
  assert.equal(row.service_name, "Synthetic E2E Edited Service");
  assert.equal(row.duration_minutes, 50);
  assert.equal(row.post_service_buffer_minutes, 0);
  assert.equal(row.price, "125050");
  assert.equal(row.draft_revision, 1);
  assert.equal(row.staff_name, "Synthetic E2E Staff");
  assert.equal(row.position_title, "Stylist");
  assert.equal(row.staff_active, true);
  assert.equal(row.location_id, locationId);
  for (const key of ["service_active", "bookable", "location_active", "assignment_active"]) {
    assert.equal(row[key], false, "A draft was unexpectedly published: " + key);
  }
  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM cookie_catalog.services WHERE tenant_id=$1::uuid) AS services,
       (SELECT count(*)::int FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid) AS staff,
       (SELECT count(*)::int FROM cookie_catalog.service_create_receipts WHERE tenant_id=$1::uuid) AS service_receipts,
       (SELECT count(*)::int FROM cookie_catalog.service_edit_receipts WHERE tenant_id=$1::uuid) AS edit_receipts,
       (SELECT count(*)::int FROM cookie_staff.staff_create_receipts WHERE tenant_id=$1::uuid) AS staff_receipts`,
    [owner.tenantId],
  );
  assert.deepEqual(counts.rows[0], { services: 1, staff: 1, service_receipts: 1, edit_receipts: 1, staff_receipts: 1 });
  return { serviceId: row.service_id, staffId: row.staff_id };
}

const BRANCH_NAME = "Synthetic E2E East";
const BRANCH_ZONE = "Asia/Yekaterinburg";

async function assertBranch(pool, owner) {
  const result = await pool.query(
    `SELECT id::text, display_name, time_zone FROM cookie_tenancy.locations
      WHERE tenant_id=$1::uuid ORDER BY id`,
    [owner.tenantId],
  );
  assert.equal(result.rowCount, 2, "Expected base and one browser-created Location");
  assert.ok(result.rows.some((row) => row.id === owner.locationId));
  const branch = result.rows.find((row) => row.display_name === BRANCH_NAME);
  assert.ok(branch, "Browser-created branch not present in PostgreSQL");
  assert.equal(branch.time_zone, BRANCH_ZONE);
  const receipt = await pool.query(
    `SELECT location_id::text FROM cookie_tenancy.location_create_receipts
      WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid`,
    [owner.tenantId, owner.identityId],
  );
  assert.deepEqual(receipt.rows, [{ location_id: branch.id }]);
  return branch.id;
}

async function assertPlan(pool, owner, staffId, locationId, date) {
  const result = await pool.query(
    `SELECT id::text, staff_id::text, location_id::text,
            start_at, end_at, active, draft_revision
       FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid`,
    [owner.tenantId],
  );
  assert.equal(result.rowCount, 1, "Expected exactly one browser-created shift");
  const shift = result.rows[0];
  assert.equal(shift.staff_id, staffId);
  assert.equal(shift.location_id, locationId);
  // Yekaterinburg is UTC+05:00 for this current future local minute.
  assert.equal(shift.start_at.toISOString(), date + "T05:00:00.000Z");
  assert.equal(shift.end_at.toISOString(), date + "T13:00:00.000Z");
  assert.equal(shift.active, false, "A draft must never publish a shift");
  assert.equal(shift.draft_revision, 0);
  const evidence = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM cookie_scheduling.shift_draft_receipts
       WHERE tenant_id=$1::uuid AND shift_id=$2::uuid AND operation='create') AS receipts,
      (SELECT count(*)::int FROM cookie_scheduling.shift_draft_audit
       WHERE tenant_id=$1::uuid AND shift_id=$2::uuid AND operation='create') AS audits,
      (SELECT count(*)::int FROM cookie_jobs.outbox_events
       WHERE tenant_id=$1::uuid AND topic='schedule.shift.draft.created') AS events`,
    [owner.tenantId, shift.id],
  );
  assert.deepEqual(evidence.rows[0], { receipts: 1, audits: 1, events: 1 });
  return shift.id;
}

async function requireOverview(cdp) {
  await button(cdp, "Обзор");
  await requireDom(cdp, "persisted organization and both branches",
    "document.querySelector('[data-component=PageHeader] h1')?.textContent.trim()==='Обзор' && " +
    "document.querySelector('[data-component=PageHeader]')?.innerText.includes('Synthetic browser salon') && " +
    "document.querySelector('.list-items')?.innerText.includes('Synthetic Central') && " +
    "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(BRANCH_NAME) + ") && " +
    "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(BRANCH_ZONE) + ")");
  await requireDom(cdp, "private customer staging link is scoped to this organization",
    "(() => {const a=[...document.querySelectorAll('a[data-slot=button]')].find(x=>x.textContent.includes('Открыть клиентский staging'));if(!a)return false;const u=new URL(a.href);return u.searchParams.get('surface')==='customer-staging'&&Boolean(u.searchParams.get('tenantId'));})()");
}

async function requireShift(cdp) {
  await button(cdp, "Расписание");
  await requireDom(cdp, "persisted inactive shift renders",
    "document.querySelector('.schedule-summary')?.innerText.includes('Synthetic E2E Staff') && " +
    "document.querySelector('.schedule-summary')?.innerText.includes(" + JSON.stringify(BRANCH_NAME) + ") && " +
    "document.querySelector('.schedule-summary')?.innerText.includes('Черновик') && " +
    "document.querySelector('.schedule-summary')?.innerText.includes(" + JSON.stringify(BRANCH_ZONE) + ")");
}

async function main() {
  const databaseUrl = isolatedDatabase();
  const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: "cookie-real-owner-browser-ci" });
  const botToken = "123456789:" + randomBytes(24).toString("base64url");
  const userHashSecret = randomBytes(32);
  const userId = randomInt(100000000, 999999999);
  const onboardingUserId = userId + 2_000_000_000;
  let browserData;
  let api, chrome, cdp;
  const errors = [], external = [], responses = [];
  let customerCreateRequests = 0;
  try {
    const owner = await seed(pool, botToken, userHashSecret, userId);
    const port = await freePort();
    const origin = "http://127.0.0.1:" + port + "/";
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
      DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: String(port),
      COOKIE_WEB_DIST: resolve("apps/web/dist"),
      COOKIE_TELEGRAM_AUTH_MODE: "enabled",
      COOKIE_TELEGRAM_SELF_REGISTRATION_MODE: "enabled",
      COOKIE_TELEGRAM_OIDC_MODE: "enabled",
      COOKIE_TELEGRAM_OIDC_CLIENT_ID: "123456789",
      COOKIE_TELEGRAM_OIDC_CLIENT_SECRET: randomBytes(32).toString("base64url"),
      COOKIE_TELEGRAM_OIDC_REDIRECT_URI: "https://cookie-e2e.invalid/auth/telegram/callback",
      COOKIE_TELEGRAM_OIDC_COOKIE_KEY: randomBytes(32).toString("hex"),
      COOKIE_STAGING_PUBLICATION_MODE: "enabled",
      COOKIE_STAGING_APPEARANCE_MODE: "enabled",
      COOKIE_STAGING_OWNER_CANCEL_CUTOFF_MINUTES: "0",
      COOKIE_STAGING_OWNER_RESCHEDULE_CUTOFF_MINUTES: "0",
      COOKIE_TELEGRAM_USER_HMAC_SECRET: userHashSecret.toString("hex"),
      COOKIE_TELEGRAM_BOT_TOKEN: botToken,
      COOKIE_PUBLIC_ORIGIN: "https://cookie-e2e.invalid",
    };
    api = await startServer(env, origin);
    const started = await startChromiumWithRetry({
      startAttempt: async () => {
        const dir = mkdtempSync(join(tmpdir(), "cookie-real-owner-"));
        try {
          const port = await freePort();
          const chrome = spawn(browserBinary(), [
            "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
            "--disable-background-networking", "--no-first-run",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=" + port,
            "--user-data-dir=" + dir,
            "about:blank",
          ], { stdio: "ignore" });
          const handle = { chrome, dir, port };
          chrome.once("error", () => { handle.startupError = "spawn failed"; });
          return handle;
        } catch (error) {
          rmSync(dir, { recursive: true, force: true });
          throw error;
        }
      },
      probe: async ({ port }) => {
        const response = await getLocal("http://127.0.0.1:" + port + "/json/list");
        return JSON.parse(response.text).find((page) => page.type === "page" && page.webSocketDebuggerUrl);
      },
      disposeAttempt: async ({ chrome, dir }) => {
        await stopBrowser(chrome);
        rmSync(dir, { recursive: true, force: true });
      },
    });
    chrome = started.handle.chrome;
    browserData = started.handle.dir;
    const target = started.ready;
    cdp = createClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["https://*"] });
    cdp.onEvent("Runtime.exceptionThrown", () => errors.push("uncaught page exception"));
    cdp.onEvent("Network.requestWillBeSent", ({ request }) => {
      if (request.url.startsWith(origin) && request.method === "POST" && new URL(request.url).pathname.endsWith("/staging-customer-bookings")) customerCreateRequests++;
      if (/^https?:/.test(request.url) && !request.url.startsWith(origin)) {
        external.push("external request blocked");
      }
    });
    cdp.onEvent("Network.responseReceived", ({ response }) => {
      if (response.url.startsWith(origin)) {
        responses.push({ path: new URL(response.url).pathname, status: response.status });
      }
    });
    await viewport(cdp, 375, 812);

    let script = await load(cdp, origin, "", undefined);
    await requireDom(cdp, "self-service role selection before authentication",
      "document.body.innerText.includes('Вход и регистрация') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Я представляю бизнес') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Я клиент')");
    await poll("auth methods response", () => responses.some((r) => r.path === "/v1/auth/methods" && r.status === 200));
    for (const [width, height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"self-service role selection "+width+"px");
      await checkLabeledControls(cdp,"self-service role selection "+width+"px");
    }
    await viewport(cdp,375,812);

    const onboardingOrganization = "Synthetic onboarding salon";
    const onboardingLocation = "Synthetic onboarding branch";
    script = await load(cdp, origin, signedProof(botToken, onboardingUserId), script);
    await requireDom(cdp, "business signup role", "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Я представляю бизнес')");
    await button(cdp, "Я представляю бизнес");
    await button(cdp, "Создать учётную запись");
    await requireDom(cdp, "single Telegram registration action", "[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Зарегистрироваться через Telegram').length===1");
    await evaluate(cdp, "window.__cookieOrganizationLookupCount=0;const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const path=new URL(String(input),window.location.href).pathname;if(path==='/v1/auth/identity/organizations'&&window.__cookieOrganizationLookupCount++===0)return Promise.resolve(new Response(null,{status:503}));return nativeFetch(input,init);};");
    await button(cdp, "Зарегистрироваться через Telegram");
    await requireDom(cdp, "organization lookup failure keeps workspace creation closed",
      "window.__cookieOrganizationLookupCount===1 && document.body.innerText.includes('Вход подтверждён, но данные учётной записи не загрузились. Повторите загрузку.') && !document.querySelector('#organization-name')");
    await button(cdp, "Повторить загрузку");
    await requireDom(cdp, "workspace form offers IANA zones and UTC offsets",
      "window.__cookieOrganizationLookupCount===2 && document.querySelector('#organization-name') && document.querySelector('#location-name') && document.querySelector('#identity-time-zone')?.tagName==='SELECT' && document.querySelector('#identity-time-zone')?.value===Intl.DateTimeFormat().resolvedOptions().timeZone && [...document.querySelectorAll('#identity-time-zone option')].some(o=>o.value==='Europe/Moscow'&&o.textContent.includes('UTC+03:00')) && document.body.innerText.includes('относительно UTC')");
    for (const [width, height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"owner workspace signup "+width+"px");
      await checkLabeledControls(cdp,"owner workspace signup "+width+"px");
    }
    await viewport(cdp,375,812);
    await fill(cdp,"#organization-name",onboardingOrganization);
    await fill(cdp,"#location-name",onboardingLocation);
    await evaluate(cdp,"(()=>{const s=document.querySelector('#identity-time-zone');s.value='Europe/Moscow';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await submitValidForm(cdp,".identity-auth-fields");
    const workspaceResponse=await poll("owner workspace API response",()=>responses.find(r=>r.path==="/v1/auth/owner/workspace"));
    assert.equal(workspaceResponse.status,201,"Owner workspace response should create a workspace; UI: "+(await evaluate(cdp,"document.body.innerText")).slice(-500));
    await requireDom(cdp,"new owner navigation after signup","document.querySelector('.real-owner-nav')");
    await button(cdp,"Обзор");
    await requireDom(cdp,"new owner workspace appears after signup",
      "document.querySelector('[data-component=PageHeader]')?.innerText.includes("+JSON.stringify(onboardingOrganization)+") && document.querySelector('.list-items')?.innerText.includes("+JSON.stringify(onboardingLocation)+")");
    const onboardingRows=await pool.query(
      `SELECT o.id::text AS tenant_id,l.id::text AS location_id,l.time_zone
         FROM cookie_tenancy.organizations o
         JOIN cookie_tenancy.locations l ON l.tenant_id=o.id
        WHERE o.display_name=$1 AND l.display_name=$2`,
      [onboardingOrganization,onboardingLocation],
    );
    assert.equal(onboardingRows.rowCount,1);
    assert.equal(onboardingRows.rows[0].time_zone,"Europe/Moscow");

    // Global identity remains authenticated across reload and explicit role
    // switch. No fresh Telegram proof or client-side credential storage.
    const beforeRestore = responses.length;
    await cdp.send("Page.reload", { ignoreCache: true });
    await poll("server-confirmed browser session restoration", () =>
      responses.slice(beforeRestore).some(r=>r.path==="/v1/auth/browser-session"&&r.status===200));
    await requireDom(cdp, "last global owner workspace restored after reload",
      "document.querySelector('.real-owner-nav')");
    await button(cdp,"Обзор");
    await requireDom(cdp,"same verified organization restored",
      "document.querySelector('[data-component=PageHeader]')?.innerText.includes("+JSON.stringify(onboardingOrganization)+")");
    assert.ok(responses.slice(beforeRestore).some(r=>r.path.endsWith("/session-context")&&r.status===200));
    await button(cdp, "Сменить кабинет");
    await requireDom(cdp, "returned to identity chooser without sign-in",
      "document.body.innerText.includes('Настройте kuki') && !document.querySelector('.real-owner-nav')");
    await button(cdp, "Я представляю бизнес");
    await requireDom(cdp, "organization still available after switching",
      "document.querySelector('.identity-organization-list')?.innerText.includes("+JSON.stringify(onboardingOrganization)+")");
    // Give only the new synthetic organization's identity a private test grant.
    // The original seeded salon retains its later no-grant acceptance test.
    const dualTenant = onboardingRows.rows[0].tenant_id;
    await issueStagingGrant(pool, dualTenant, 1, new Date(Date.now()+3600000).toISOString());
    await button(cdp,"Сменить сценарий");
    await requireDom(cdp,"dual role client choice available",
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Я клиент'&&!b.disabled)");
    await button(cdp,"Я клиент");
    await requireDom(cdp,"explicit first client enrollment","document.querySelector('#customer-tenant-id') && !document.querySelector('#customer-tenant-id').disabled");
    await fill(cdp,"#customer-tenant-id",dualTenant);
    await evaluate(cdp,"document.querySelector('.identity-consent input').click()");
    await requireDom(cdp,"consented client enrollment ready","[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Продолжить как клиент'&&!b.disabled)");
    const customerChunk = (r) => /^\/assets\/StagingCustomerGate-[^/]+\.js$/.test(r.path);
    assert.equal(responses.filter(customerChunk).length, 0, "Customer workspace loaded before entering it");
    await button(cdp,"Продолжить как клиент");
    await poll("customer workspace loaded on demand", () =>
      responses.some((r) => customerChunk(r) && r.status === 200));
    const clientGate = "document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.textContent.trim()==='Вход клиента подтверждён' && !document.querySelector('.real-owner-nav')";
    await requireDom(cdp,"same identity enters client workspace",clientGate);
    const enrolled = await pool.query(
      "SELECT c.customer_id::text,c.identity_id::text FROM cookie_customers.staging_customer_identities c WHERE c.tenant_id=$1::uuid",
      [dualTenant],
    );
    assert.equal(enrolled.rowCount,1);
    const roles = await pool.query(
      "SELECT DISTINCT r.base_type FROM cookie_identity.roles r JOIN cookie_identity.role_assignments a ON a.tenant_id=r.tenant_id AND a.role_id=r.id WHERE r.tenant_id=$1::uuid AND a.identity_id=$2::uuid AND a.active AND r.active ORDER BY r.base_type",
      [dualTenant,enrolled.rows[0].identity_id],
    );
    assert.deepEqual(roles.rows.map(r=>r.base_type),["client","owner"]);
    const beforeClientReload=responses.length;
    await cdp.send("Page.reload",{ignoreCache:true});
    await poll("client cookie restored",()=>responses.slice(beforeClientReload).some(r=>r.path==="/v1/auth/browser-session"&&r.status===200));
    await requireDom(cdp,"client workspace restored after reload",clientGate);
    await button(cdp,"Сменить кабинет");
    await requireDom(cdp,"identity chooser after client workspace","document.body.innerText.includes('Настройте kuki') && !document.querySelector('.real-owner-nav')");
    await button(cdp,"Я представляю бизнес");
    await requireDom(cdp,"dual role owner membership","document.querySelector('.identity-organization-list')?.innerText.includes("+JSON.stringify(onboardingOrganization)+")");
    await evaluate(cdp,"[...document.querySelectorAll('.identity-organization-list button')].find(b=>b.textContent.includes("+JSON.stringify(onboardingOrganization)+")&&!b.disabled).click()");
    await requireDom(cdp,"owner workspace reentered without authentication","document.querySelector('.real-owner-nav')");
    await button(cdp,"Сменить кабинет");
    await requireDom(cdp,"client choice after returning from owner","[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Я клиент'&&!b.disabled)");
    await button(cdp,"Я клиент");
    await requireDom(cdp,"existing customer visible without new enrollment","document.querySelector('[aria-label=\"Клиентские организации\"]')?.innerText.includes("+JSON.stringify(onboardingOrganization)+")");
    await evaluate(cdp,"document.querySelector('[aria-label=\"Клиентские организации\"] button').click()");
    await requireDom(cdp,"existing customer reentered",clientGate);
    assert.equal(responses.slice(beforeRestore).filter(r=>r.path.endsWith("/staging-customer/enroll")).length,1,"Existing client selection must not enroll again");
    assert.deepEqual((await pool.query("SELECT c.customer_id::text,c.identity_id::text FROM cookie_customers.staging_customer_identities c WHERE c.tenant_id=$1::uuid",[dualTenant])).rows,enrolled.rows);
    // Actual committed role revocation (not a mocked 403) must close only
    // the client workspace and preserve the independently valid identity.
    await requireDom(cdp,"customer catalog ready before role revocation","[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Обновить каталог'&&!b.disabled)");
    const revokedClient=await pool.query(
      "UPDATE cookie_identity.role_assignments a SET active=false FROM cookie_identity.roles r WHERE a.tenant_id=$1::uuid AND a.identity_id=$2::uuid AND a.tenant_id=r.tenant_id AND a.role_id=r.id AND r.base_type='client' AND a.active",
      [dualTenant,enrolled.rows[0].identity_id],
    );
    assert.equal(revokedClient.rowCount,1);
    const beforeDenied=responses.length;
    await button(cdp,"Обновить каталог");
    await requireDom(cdp,"revoked client returns to authenticated chooser","document.body.innerText.includes('Настройте kuki') && document.body.innerText.includes('Доступ к клиентскому кабинету не подтверждён') && !document.querySelector('.real-owner-nav')");
    assert.ok(responses.slice(beforeDenied).some(r=>r.path.endsWith("/staging-customer-offers")&&r.status===403));
    await button(cdp,"Я представляю бизнес");
    await requireDom(cdp,"owner role survives client revocation","document.querySelector('.identity-organization-list')?.innerText.includes("+JSON.stringify(onboardingOrganization)+")");
    await evaluate(cdp,"[...document.querySelectorAll('.identity-organization-list button')].find(b=>b.textContent.includes("+JSON.stringify(onboardingOrganization)+")&&!b.disabled).click()");
    await requireDom(cdp,"owner workspace still accessible","document.querySelector('.real-owner-nav')");
    await evaluate(cdp, "history.replaceState({...history.state,kukiEarlierRoute:true},'')");
    await button(cdp, "Календарь");
    await requireDom(cdp, "owner navigation retains verified workspace hint",
      "location.pathname==='/calendar' && history.state?.kukiWorkspace?.role==='business'");
    await button(cdp,"Сменить кабинет");
    await requireDom(cdp,"identity chooser before logout","document.body.innerText.includes('Настройте kuki') && !document.querySelector('.real-owner-nav')");
    assert.equal(responses.slice(beforeRestore).filter(r=>r.path==="/v1/auth/telegram/identity").length,0);
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    // Simulate a transport failure before the logout request reaches the API.
    // The HttpOnly cookie is therefore still live; reload must not restore it.
    await requireDom(cdp,"ready for failed logout","[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Выйти из учётной записи'&&!b.disabled)");
    await evaluate(cdp,"(()=>{const original=window.fetch.bind(window);window.fetch=(input,init)=>new URL(String(input),location.href).pathname==='/v1/auth/identity/logout'?Promise.reject(new TypeError('synthetic offline')):original(input,init);})()");
    await button(cdp,"Выйти из учётной записи");
    await requireDom(cdp,"failed logout local access closed","document.body.innerText.includes('сервер не подтвердил отзыв') && !document.querySelector('.real-owner-nav')");
    assert.equal(await evaluate(cdp,"history.state?.kukiLogoutPending"),true);
    const beforeFailedLogoutReload=responses.length;
    // Re-open the existing Telegram identity explicitly using a fresh proof
    // after checking that normal reload did not silently restore its cookie.
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument",{identifier:script});
    const freshProof=signedProof(botToken,onboardingUserId);
    ({identifier:script}=await cdp.send("Page.addScriptToEvaluateOnNewDocument",{
      source:"window.Telegram={WebApp:{initData:"+JSON.stringify(freshProof)+"}};window.__cookieTestClockMs=0;const realNow=Date.now.bind(Date);Date.now=()=>realNow()+window.__cookieTestClockMs;",
    }));
    await cdp.send("Page.reload",{ignoreCache:true});
    await requireDom(cdp,"pending logout blocks automatic restore","document.body.innerText.includes('Автоматическое восстановление отключено') && !document.body.innerText.includes('Настройте kuki') && !document.querySelector('.real-owner-nav')");
    await poll("methods after failed logout reload",()=>responses.slice(beforeFailedLogoutReload).some(r=>r.path==="/v1/auth/methods"&&r.status===200));
    assert.ok(!responses.slice(beforeFailedLogoutReload).some(r=>r.path==="/v1/auth/browser-session"));
    const beforeBackReload = responses.length;
    await evaluate(cdp, "history.back()");
    await requireDom(cdp, "earlier owner history entry after failed logout",
      "history.state?.kukiEarlierRoute===true && history.state?.kukiLogoutPending!==true && !document.querySelector('.real-owner-nav')");
    await cdp.send("Page.reload", {ignoreCache:true});
    await requireDom(cdp, "failed logout blocks restore from earlier route",
      "document.body.innerText.includes('Автоматическое восстановление отключено') && !document.querySelector('.real-owner-nav')");
    await poll("methods after earlier route reload",()=>responses.slice(beforeBackReload).some(r=>r.path==="/v1/auth/methods"&&r.status===200));
    assert.ok(!responses.slice(beforeBackReload).some(r=>r.path==="/v1/auth/browser-session"));
    await button(cdp,"Я представляю бизнес");
    await requireDom(cdp,"explicit Telegram reauthentication ready","[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Войти через Telegram'&&!b.disabled)");
    await button(cdp,"Войти через Telegram");
    await requireDom(cdp,"fresh identity after failed logout","document.body.innerText.includes('Настройте kuki') && document.querySelector('.identity-organization-list')?.innerText.includes("+JSON.stringify(onboardingOrganization)+")");
    assert.equal(await evaluate(cdp,"history.state?.kukiLogoutPending===true"),false);
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    // A second actual Chromium tab shares the browser cookie but not its JS
    // memory or history hint. It must close the owner UI after the first logs out.
    const {targetId:secondId}=await cdp.send("Target.createTarget",{url:"about:blank"});
    const secondTarget=await poll("second browser tab",async()=>{
      const response=await getLocal("http://127.0.0.1:"+started.handle.port+"/json/list");
      return JSON.parse(response.text).find(page=>page.id===secondId&&page.webSocketDebuggerUrl);
    });
    const second=createClient(secondTarget.webSocketDebuggerUrl);
    try {
      await second.ready;
      await second.send("Page.enable");
      await second.send("Runtime.enable");
      await second.send("Network.enable");
      await second.send("Network.setBlockedURLs",{urls:["https://*"]});
      const secondResponses=[];
      second.onEvent("Runtime.exceptionThrown",()=>errors.push("uncaught second tab exception"));
      second.onEvent("Network.responseReceived",({response})=>{
        if(response.url.startsWith(origin)) secondResponses.push({path:new URL(response.url).pathname,status:response.status});
      });
      await viewport(second,375,812);
      await load(second,origin,"",undefined);
      await requireDom(second,"second tab restores shared identity","document.body.innerText.includes('Настройте kuki')");
      await button(second,"Я представляю бизнес");
      await requireDom(second,"second tab owner membership","document.querySelector('.identity-organization-list')?.innerText.includes("+JSON.stringify(onboardingOrganization)+")");
      await evaluate(second,"[...document.querySelectorAll('.identity-organization-list button')].find(b=>b.textContent.includes("+JSON.stringify(onboardingOrganization)+")&&!b.disabled).click()");
      await requireDom(second,"second tab authenticated owner","document.querySelector('.real-owner-nav')");
      assert.ok(secondResponses.some(r=>r.path==="/v1/auth/browser-session"&&r.status===200));
      assert.ok(!secondResponses.some(r=>r.path==="/v1/auth/telegram/identity"));
      await requireDom(cdp,"first tab ready to sign out","[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Выйти из учётной записи'&&!b.disabled)");
      await button(cdp,"Выйти из учётной записи");
      await requireDom(cdp,"global logout before separate-account test",
        "document.body.innerText.includes('Вы вышли') && !document.querySelector('.real-owner-nav')");
      await requireDom(second,"second tab closes revoked owner UI",
        "!document.querySelector('.real-owner-nav') && document.body.innerText.includes('Сессия в браузере изменилась или завершилась')");
      assert.ok(secondResponses.some(r=>r.path==="/v1/auth/browser-session"&&r.status===401));
      assert.equal(await evaluate(second,"localStorage.length + sessionStorage.length"),0);
    } finally {
      second.close();
      await cdp.send("Target.closeTarget",{targetId:secondId});
    }
    const logoutMarker = responses.length;
    script = await load(cdp, origin, "", script);
    await poll("revoked global session no longer restores",()=>responses.slice(logoutMarker).some(r=>r.path==="/v1/auth/browser-session"&&r.status===401));

    // A fast 503 from one account endpoint must not mask a later real 401
    // from another endpoint after PostgreSQL Identity session revocation.
    // This is a source-backed browser test, not a mock authorization decision.
    script = await load(cdp, origin, signedProof(botToken,onboardingUserId), script);
    await evaluate(cdp,`(()=>{const original=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const path=new URL(String(input),location.href).pathname;
        if(path==='/v1/auth/identity/providers')return Promise.resolve(new Response(null,{status:503}));
        if(path==='/v1/auth/identity/organizations')return new Promise(resolve=>{
          window.__kukiReleaseOrganizations=()=>resolve(original(input,init));
        });
        return original(input,init);
      };
    })()`);
    await enterTelegram(cdp,"business");
    await requireDom(cdp,"transient provider error permits retry until definitive denial",
      "typeof window.__kukiReleaseOrganizations==='function' && document.body.innerText.includes('Вход подтверждён, но данные учётной записи не загрузились. Повторите загрузку.') && document.body.innerText.includes('Настройте kuki')");
    const beforeAccountDenial = responses.length;
    assert.ok((await pool.query(
      "UPDATE cookie_identity.identity_sessions SET revoked_at=clock_timestamp() WHERE identity_id=$1::uuid AND issuer='cookie-telegram' AND revoked_at IS NULL",
      [enrolled.rows[0].identity_id],
    )).rowCount >= 1);
    await evaluate(cdp,"window.__kukiReleaseOrganizations()");
    await poll("actual PostgreSQL-revoked Identity account read returns 401",()=>responses.slice(beforeAccountDenial).some(r=>r.path==="/v1/auth/identity/organizations"&&r.status===401));
    await requireDom(cdp,"late 401 clears current global account chooser",
      "document.body.innerText.includes('Сессия завершилась. Войдите снова.') && !document.body.innerText.includes('Настройте kuki') && !document.querySelector('.identity-organization-list, .identity-provider-section, .real-owner-nav')");
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    console.log("PASS account denial after parallel transient error");

    const browserAuthResponsesBefore = responses.length;
    script = await load(cdp, origin, "", script);
    await poll("regular browser auth methods response", () =>
      responses.slice(browserAuthResponsesBefore).some((r) => r.path === "/v1/auth/methods" && r.status === 200),
    );
    await button(cdp, "Я представляю бизнес");
    await requireDom(cdp, "single regular-browser Telegram action",
      "!document.body.innerText.includes('email и пароль') && [...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Войти через Telegram').length===1");
    await evaluate(cdp, "window.Telegram.WebApp.initData='synthetic-browser-only';window.__cookieTelegramAuthRequests=[];const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const path=new URL(String(input),window.location.href).pathname;if(path==='/v1/auth/telegram/oidc/start'){window.__cookieTelegramAuthRequests.push(path);return Promise.resolve(new Response(null,{status:503}));}return nativeFetch(input,init);};");
    await button(cdp, "Войти через Telegram");
    await requireDom(cdp, "regular browser starts Telegram Web authorization",
      "window.__cookieTelegramAuthRequests.length===1 && window.__cookieTelegramAuthRequests[0]==='/v1/auth/telegram/oidc/start' && document.body.innerText.includes('Сервер недоступен или не подтвердил действие. Попробуйте ещё раз.')");

    // Malformed proof must not show authenticated UI or a synthetic fallback.
    script = await load(cdp, origin + "calendar", "invalid-synthetic-proof", script);
    await enterTelegram(cdp, "business");
    await requireDom(cdp, "forged proof rejected",
      "location.pathname==='/calendar' && document.body.innerText.includes('Не удалось подтвердить вход') && !document.querySelector('.real-owner-nav')");
    assert.ok(responses.some((r) => r.path === "/v1/auth/telegram/identity" && r.status === 401));
    script = await loadAndEnterTelegram(cdp, origin + "locations", signedProof(botToken, userId), script, "business");
    await requireDom(cdp, "authenticated direct location link",
      "location.pathname==='/locations' && document.querySelector('.real-owner-nav') && document.querySelector('.list-items')?.innerText.includes('Synthetic Central')");
    await evaluate(cdp, "window.__kukiNavigationMarker=1");
    await button(cdp, "Услуги");
    await requireDom(cdp, "owner click updates path without reload",
      "location.pathname==='/services' && window.__kukiNavigationMarker===1 && document.body.innerText.includes('Услуги салона')");
    await requireDom(cdp, "only one owner page title",
      "document.querySelectorAll('main h1').length===1 && document.querySelector('[data-component=PageHeader] h1').textContent==='Услуги салона'");
    await requireDom(cdp, "service action ready",
      "[...document.querySelectorAll('[data-component=PageHeader] button')].some(b=>b.textContent.trim()==='Новая услуга'&&!b.disabled)");
    await button(cdp, "Новая услуга");
    await requireDom(cdp, "new service focuses the real editor",
      "document.activeElement instanceof HTMLInputElement && document.activeElement.closest('.owner-form')!==null");
    await evaluate(cdp, "history.back()");
    await requireDom(cdp, "back restores locations",
      "location.pathname==='/locations' && window.__kukiNavigationMarker===1 && document.querySelector('[data-screen=locations][aria-current=page]')");
    await evaluate(cdp, "history.forward()");
    await requireDom(cdp, "forward restores services",
      "location.pathname==='/services' && window.__kukiNavigationMarker===1 && document.querySelector('[data-screen=services][aria-current=page]')");
    await requireDom(cdp, "shared owner shell without demo controls", "document.querySelector(\'.verified-owner-shell[data-cookie-mode=api] .sidebar\') && !document.querySelector(\'.demo-ribbon, .preview-control, .onboarding-header\')");
    await requireDom(cdp, "canonical runtime owner brand", "document.querySelector('.sidebar .brand strong')?.textContent.trim() === 'kuki.' && document.querySelector('.nav-links')?.getAttribute('aria-label') === 'Разделы kuki' && document.title === 'kuki — кабинет салона'");
    const appearanceChunk = (response) => /^\/assets\/RealOwnerAppearancePage-[^/]+\.js$/.test(response.path);
    assert.equal(responses.filter(appearanceChunk).length, 0, "Appearance module loaded before navigation");
    await button(cdp, "Оформление");
    await poll("appearance module downloaded on demand", () =>
      responses.some((response) => appearanceChunk(response) && response.status === 200),
    );
    await requireDom(cdp, "real appearance draft loaded", "document.querySelector('.brand-editor') && document.body.innerText.includes('Не опубликовано') && document.querySelector('.brand-presets button')");
    await checkWidth(cdp, "real appearance 375px");
    await evaluate(cdp, "[...document.querySelectorAll('.brand-presets button')].find(b=>b.textContent.includes('Ботаника')).click()");
    await button(cdp, "Сохранить черновик");
    await requireDom(cdp, "appearance saved on server", "document.body.innerText.includes('Черновик сохранён на сервере') && document.querySelector('.brand-presets button.active')?.textContent.includes('Ботаника')");
    const brand = await pool.query("SELECT draft_revision::text, draft_config, published_revision FROM cookie_appearance.organization_branding WHERE tenant_id=$1::uuid", [owner.tenantId]);
    assert.equal(brand.rows[0]?.draft_revision, "1");
    assert.equal(brand.rows[0]?.draft_config.presetId, "forest");
    assert.equal(brand.rows[0]?.published_revision, null);
    await button(cdp, "Услуги");
    await button(cdp, "Оформление");
    await requireDom(cdp, "persisted appearance reloaded", "document.querySelector('.brand-presets button.active')?.textContent.includes('Ботаника') && [...document.querySelectorAll('.brand-actions button')].find(b=>b.textContent.trim()==='Опубликовать')?.disabled && [...document.querySelectorAll('.brand-assets input')].every(i=>i.matches(':disabled'))");
    assert.equal(responses.filter(appearanceChunk).length, 1, "Appearance module requested again within the same document");
    assert.ok(responses.some(r => r.status === 404 && r.path.endsWith("/appearance/published")),
      "Owner must see 404 for a never-published appearance");
    assert.ok(responses.some(r => r.status === 200 && r.path.endsWith("/appearance/publication")),
      "Explicit staging mode must serve the authenticated owner capability endpoint");

    await button(cdp, "Онлайн-запись");
    await requireDom(cdp, "owner booking unavailable without customer identity", "document.querySelector('h1')?.textContent==='Онлайн-запись' && document.body.innerText.includes('Клиентская запись — отдельный вход') && !document.querySelector('.booking-form')");
    await button(cdp, "Услуги");
    await waitForm(cdp, "real service form");
    await checkWidth(cdp, "real services 375px");
    await checkLabeledControls(cdp, "real service form");
    await fill(cdp, ".owner-form input:not([type=number])", "Synthetic E2E Service");
    await fill(cdp, ".owner-form input[type=number]:nth-of-type(1)", "45");
    // Enter the business inputs explicitly, including the new buffer.
    await evaluate(cdp, "(() => {const n=document.querySelectorAll('.owner-form input[type=number]');n[0].value='45';n[0].dispatchEvent(new Event('input',{bubbles:true}));n[1].value='1200';n[1].dispatchEvent(new Event('input',{bubbles:true}));})()");
    await fill(cdp, ".owner-form input[name=post-service-buffer-minutes]", "15");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "persisted service renders",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Service') && document.querySelector('.list-items')?.innerText.includes('Буфер: 15 мин') && !document.querySelector('.owner-form button[type=submit]')?.disabled");
    const serviceReadsBeforeFilter = responses.filter(r=>r.path.endsWith("/services")).length;
    await fill(cdp, ".service-directory input[type=search]", "  SYNTHETIC E2E  ");
    await requireDom(cdp, "case insensitive service search", "document.querySelector('.list-items [data-component=RecordRow]')?.innerText.includes('Synthetic E2E Service')");
    await button(cdp, "Активные");
    await requireDom(cdp, "draft not shown in active filter", "document.querySelector('[data-component=EmptyState]')?.innerText.includes('Услуги не найдены') && !document.querySelector('.list-items')");
    await button(cdp, "Черновики");
    await requireDom(cdp, "draft filter restores record", "document.querySelector('.list-items [data-component=RecordRow]')?.innerText.includes('Synthetic E2E Service')");
    await fill(cdp, ".service-directory input[type=search]", "no-matching-service");
    await requireDom(cdp, "search empty differs from empty catalog", "document.querySelector('[data-component=EmptyState]')?.innerText.includes('Услуги не найдены') && !document.querySelector('.list-items')");
    await button(cdp, "Сбросить фильтры");
    await requireDom(cdp, "reset restores catalog", "document.querySelector('.service-directory input').value==='' && document.querySelector('.list-items [data-component=RecordRow]') && [...document.querySelectorAll('.service-directory [aria-pressed=true]')].some(b=>b.textContent.trim()==='Все')");
    assert.equal(responses.filter(r=>r.path.endsWith("/services")).length,serviceReadsBeforeFilter,"Filtering must use the existing server snapshot");
    for (const [width,height] of [[320,568],[375,812],[768,900],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"RC9.4 service directory "+width+"px");
      await checkLabeledControls(cdp,"RC9.4 service directory "+width+"px");
    }
    await viewport(cdp,375,812);
    const initialBuffer = await pool.query("SELECT post_service_buffer_minutes FROM cookie_catalog.services WHERE tenant_id=$1::uuid", [owner.tenantId]);
    assert.deepEqual(initialBuffer.rows, [{post_service_buffer_minutes:15}]);
    await button(cdp, "Филиалы");
    await requireDom(cdp, "real locations loaded",
      "document.querySelector('h1')?.textContent.trim()==='Филиалы' && document.querySelector('.list-items')?.innerText.includes('Synthetic Central') && document.querySelector('.owner-form input')");
    await checkWidth(cdp, "real locations 375px");
    await checkLabeledControls(cdp, "real locations form");
    await requireDom(cdp, "shared location editor", "document.querySelector('form[data-component=EntityEditor].owner-form')?.getAttribute('aria-busy')==='false'");
    await button(cdp, "Новый филиал");
    await requireDom(cdp, "new location focuses name", "document.activeElement===document.querySelector('.owner-form input[placeholder=\'Студия на Невском\']')");
    assert.equal(await evaluate(cdp, "document.querySelector('.owner-form').checkValidity()"), false);
    const requestsBeforeInvalidLocation = responses.filter(r=>r.path.endsWith("/locations")).length;
    await fill(cdp, ".owner-form input[placeholder='Студия на Невском']", BRANCH_NAME);
    await fill(cdp, ".owner-form input[placeholder='Europe/Moscow']", "Invalid/Timezone");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "invalid location timezone retains input", "document.querySelector('.alert-error')?.innerText.includes('IANA') && document.querySelector('.owner-form input[placeholder=\'Europe/Moscow\']')?.value==='Invalid/Timezone'");
    assert.equal(responses.filter(r=>r.path.endsWith("/locations")).length,requestsBeforeInvalidLocation,"Invalid timezone must not send a create request");
    await fill(cdp, ".owner-form input[placeholder='Europe/Moscow']", BRANCH_ZONE);
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "browser-created branch saved",
      "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(BRANCH_NAME) + ") && !document.querySelector('.owner-form button[type=submit]')?.disabled");
    const locationId = await assertBranch(pool, owner);
    const locationsBeforeFilter = responses.filter(r=>r.path.endsWith("/locations")).length;
    await fill(cdp, ".location-directory input[type=search]", BRANCH_ZONE.toUpperCase());
    await requireDom(cdp, "location search by time zone", "document.querySelector('.list-items [data-component=RecordRow]')?.innerText.includes("+JSON.stringify(BRANCH_NAME)+")");
    await fill(cdp, ".location-directory input[type=search]", "no-matching-branch");
    await requireDom(cdp, "no matching location", "document.querySelector('[data-component=EmptyState]')?.innerText.includes('Филиалы не найдены') && !document.querySelector('.list-items')");
    await button(cdp, "Сбросить поиск");
    await requireDom(cdp, "location search reset", "document.querySelector('.location-directory input').value==='' && document.querySelector('.list-items')?.innerText.includes('Synthetic Central') && document.querySelector('.list-items')?.innerText.includes("+JSON.stringify(BRANCH_NAME)+")");
    assert.equal(responses.filter(r=>r.path.endsWith("/locations")).length,locationsBeforeFilter,"Location filtering must not request new data");
    for (const [width,height] of [[320,568],[375,812],[768,900],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"RC9.4 location directory "+width+"px");
      await checkLabeledControls(cdp,"RC9.4 location directory "+width+"px");
    }
    await viewport(cdp,375,812);
    await requireOverview(cdp);
    await fill(cdp, ".owner-day-overview select", locationId, "change");
    await requireDom(cdp, "selected branch day loaded from API",
      "document.querySelector('.owner-day-overview select')?.value==="+JSON.stringify(locationId)+" && document.querySelector('.owner-day-overview [data-component=MetricStrip]') && document.querySelector('.owner-day-overview')?.innerText.includes('На сегодня записей нет.')");
    await checkWidth(cdp, "real overview 375px");
    await button(cdp, "Весь календарь");
    await requireDom(cdp, "overview shortcut preserves selected branch",
      "document.querySelector('.owner-calendar select')?.value==="+JSON.stringify(locationId)+" && document.querySelector('.owner-calendar input[type=date]')?.disabled===false");

    await button(cdp, "Мастера");
    await requireDom(cdp, "real staff page", "document.querySelector('h1')?.textContent.trim()==='Мастера'");
    await requireDom(cdp, "real staff form", "document.querySelectorAll('.owner-form select').length===2");
    await checkWidth(cdp, "real staff 375px");
    await checkLabeledControls(cdp, "real staff form");
    await fill(cdp, ".owner-form select", locationId, "change");
    assert.equal(await evaluate(cdp, "document.querySelector('.owner-form select').value"), locationId);
    await fill(cdp, ".owner-form input:nth-of-type(1)", "Synthetic E2E Staff");
    await evaluate(cdp, "(() => {const n=document.querySelectorAll('.owner-form input');n[0].value='Synthetic E2E Staff';n[0].dispatchEvent(new Event('input',{bubbles:true}));n[1].value='Stylist';n[1].dispatchEvent(new Event('input',{bubbles:true}));})()");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "persisted staff renders",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff') && !document.querySelector('.owner-form button[type=submit]')?.disabled");
    const staffReadsBeforeFilter = responses.filter(r=>r.path.endsWith("/staff")||r.path.endsWith("/services")).length;
    await fill(cdp, ".staff-directory input[type=search]", "  STYLIST  ");
    await requireDom(cdp, "staff search by specialization", "document.querySelector('.list-items [data-component=RecordRow]')?.innerText.includes('Synthetic E2E Staff')");
    await fill(cdp, ".staff-directory select", locationId, "change");
    await requireDom(cdp, "staff filter uses assigned location ID", "document.querySelector('.staff-directory select').value==="+JSON.stringify(locationId)+" && document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    await evaluate(cdp, "(()=>{const s=document.querySelector('.staff-directory select');s.value=[...s.options].find(o=>o.value&&o.value!=="+JSON.stringify(locationId)+").value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await requireDom(cdp, "other branch does not show staff", "document.querySelector('[data-component=EmptyState]')?.innerText.includes('Мастера не найдены') && !document.querySelector('.list-items')");
    await fill(cdp, ".staff-directory select", locationId, "change");
    await button(cdp, "Активированы");
    await requireDom(cdp, "unpublished staff not bookable", "document.querySelector('[data-component=EmptyState]')?.innerText.includes('Мастера не найдены')");
    await button(cdp, "Черновики");
    await requireDom(cdp, "draft staff filter", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    await fill(cdp, ".staff-directory input[type=search]", "no-matching-staff");
    await requireDom(cdp, "staff search no results", "document.querySelector('[data-component=EmptyState]')?.innerText.includes('Мастера не найдены')");
    await button(cdp, "Сбросить фильтры");
    await requireDom(cdp, "staff filters reset", "document.querySelector('.staff-directory input').value==='' && document.querySelector('.staff-directory select').value==='' && document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    assert.equal(responses.filter(r=>r.path.endsWith("/staff")||r.path.endsWith("/services")).length,staffReadsBeforeFilter,"Staff filtering must not request new data");
    for (const [width,height] of [[320,568],[375,812],[768,900],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"RC9.4 staff directory "+width+"px");
      await checkLabeledControls(cdp,"RC9.4 staff directory "+width+"px");
    }
    await viewport(cdp,375,812);
    await button(cdp, "Услуги");
    await requireDom(cdp, "service edit button", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Service')");
    await button(cdp, "Изменить");
    await requireDom(cdp, "edit selected", "document.querySelector('.owner-form')?.innerText.includes('Сохранить изменения') && document.querySelector('input[name=post-service-buffer-minutes]')?.value==='15'");
    await requireDom(cdp, "edit focuses name input", "document.activeElement===document.querySelector('.owner-form input:not([type=number])')");
    await evaluate(cdp, "(() => {const inputs=document.querySelectorAll('.owner-form input');const values=['Synthetic E2E Edited Service','50','1250.50','0'];inputs.forEach((input,i)=>{input.value=values[i];input.dispatchEvent(new Event('input',{bubbles:true}));});})()");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "edited service visible", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service') && document.querySelector('.list-items')?.innerText.includes('50 мин') && document.querySelector('.list-items')?.innerText.includes('Буфер: 0 мин')");
    await checkWidth(cdp, "edited list 375px");
    await button(cdp, "Мастера");
    await requireDom(cdp, "assignment retains edited service", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
    const beforeRestart = await assertStored(pool, owner, locationId);
    assert.ok(responses.some((r) => r.status === 200 && r.path.endsWith('/services/' + beforeRestart.serviceId)));
    const scheduleChunk = (r) => /^\/assets\/RealOwnerSchedulePage-[^/]+\.js$/.test(r.path);
    assert.equal(responses.filter(scheduleChunk).length, 0, "Schedule editor loaded before navigation");
    await button(cdp, "Расписание");
    await poll("schedule editor loaded on demand", () =>
      responses.some((r) => scheduleChunk(r) && r.status === 200));
    await requireDom(cdp, "real schedule loaded with assigned branch",
      "document.querySelector('h1')?.textContent.trim()==='Расписание' && document.querySelectorAll('.owner-form input[type=datetime-local]').length===2 && " +
      "document.querySelector('.owner-form .owner-form-note')?.innerText.includes(" + JSON.stringify(BRANCH_ZONE) + ")");
    await checkWidth(cdp, "real schedule 375px");
    await checkLabeledControls(cdp, "real schedule form");
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    await evaluate(cdp, "(() => {const fields=document.querySelectorAll('.owner-form input[type=datetime-local]');" +
      "const values=" + JSON.stringify([date + "T10:00", date + "T18:00"]) + ";" +
      "fields.forEach((field,index)=>{field.value=values[index];field.dispatchEvent(new Event('change',{bubbles:true}));});})()");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "browser shift draft and server confirmation",
      "document.querySelector('.schedule-summary')?.innerText.includes('Synthetic E2E Staff') && " +
      "document.querySelector('.schedule-summary')?.innerText.includes('Черновик') && " +
      "document.querySelector('.alert-ok')?.innerText.includes('Черновик сохранён') && !document.querySelector('.owner-form button[type=submit]')?.disabled");
    const shiftId = await assertPlan(pool, owner, beforeRestart.staffId, locationId, date);
    await benchmarkOwnerNavigation(cdp);
    // The compiled API mounts the real owner publish route only because BOTH
    // explicit staging flags are set, but a separately issued live Appearance
    // grant is still mandatory. No grant is seeded at onboarding.
    await button(cdp, "Услуги");
    await button(cdp, "Оформление");
    await requireDom(cdp, "owner publish disabled without a live Appearance grant",
      "document.querySelector('.brand-editor') && " +
      "[...document.querySelectorAll('.brand-actions button')].find(b=>b.textContent.trim()==='Опубликовать')?.disabled && " +
      "document.body.innerText.includes('Публикация недоступна')");
    const appearanceGrantId = randomUUID();
    await pool.query(
      "INSERT INTO cookie_entitlement.staging_appearance_grants (tenant_id,id,expires_at) VALUES ($1::uuid,$2::uuid,clock_timestamp()+interval '1 hour')",
      [owner.tenantId, appearanceGrantId]);
    await button(cdp, "Услуги");
    await button(cdp, "Оформление");
    await requireDom(cdp, "verified owner publication button enabled by server policy and grant",
      "document.querySelector('.brand-editor') && " +
      "[...document.querySelectorAll('.brand-actions button')].find(b=>b.textContent.trim()==='Опубликовать')?.disabled===false");
    await button(cdp, "Опубликовать");
    await requireDom(cdp, "actual owner publish POST confirmed by authoritative GET",
      "document.body.innerText.includes('Сервер подтвердил публикацию оформления версии 1') && " +
      "document.querySelector('.brand-state')?.innerText.includes('Опубликовано · версия 1')");
    assert.equal(responses.filter(r => r.status === 200 && r.path.endsWith("/appearance/publish")).length, 1,
      "Expected exactly one actual owner POST to publish");
    const appearanceAudit = await pool.query(
      "SELECT revision::text,grant_id::text,actor_identity_id::text FROM cookie_appearance.publication_audit WHERE tenant_id=$1::uuid",
      [owner.tenantId]);
    assert.deepEqual(appearanceAudit.rows, [{revision:"1",grant_id:appearanceGrantId,actor_identity_id:owner.identityId}],
      "Actual owner publish must create an atomic grant-bound actor audit");
    await requireDom(cdp, "real published snapshot read into owner browser",
      "document.querySelector('.brand-state')?.innerText.includes('Опубликовано · версия 1') && " +
      "document.body.innerText.includes('На сервере опубликована версия 1 (Ботаника)') && " +
      "document.body.innerText.includes('Черновик совпадает с опубликованной версией.') && " +
      "[...document.querySelectorAll('.brand-actions button')].find(b=>b.textContent.trim()==='Опубликовать')?.disabled");
    assert.ok(responses.some(r => r.status === 200 && r.path.endsWith("/appearance/published")),
      "Missing real authenticated published Appearance GET");
    await checkWidth(cdp, "published owner appearance 375px");

    // The browser may save a newer draft, but must keep showing the older
    // published version until an independently authorized publish succeeds.
    await evaluate(cdp, "[...document.querySelectorAll('.brand-presets button')].find(b=>b.textContent.includes('Горизонт')).click()");
    await button(cdp, "Сохранить черновик");
    await requireDom(cdp, "newer owner draft cannot impersonate published theme",
      "document.querySelector('.brand-presets button.active')?.textContent.includes('Горизонт') && " +
      "document.querySelector('.brand-state')?.innerText.includes('Опубликовано · версия 1') && " +
      "document.body.innerText.includes('Текущий черновик ещё не опубликован.') && " +
      "document.body.innerText.includes('Черновик сохранён на сервере')");
    const afterNewerDraft = await pool.query(
      "SELECT draft_revision::text, draft_config, published_revision::text, published_config FROM cookie_appearance.organization_branding WHERE tenant_id=$1::uuid",
      [owner.tenantId]);
    assert.equal(afterNewerDraft.rows[0]?.draft_revision, "2");
    assert.equal(afterNewerDraft.rows[0]?.draft_config.presetId, "ocean");
    assert.equal(afterNewerDraft.rows[0]?.published_revision, "1");
    assert.equal(afterNewerDraft.rows[0]?.published_config.presetId, "forest");

    // Keep the pre-existing warm navigation benchmark's Botanika fixture.
    await evaluate(cdp, "[...document.querySelectorAll('.brand-presets button')].find(b=>b.textContent.includes('Ботаника')).click()");
    await button(cdp, "Сохранить черновик");
    await requireDom(cdp, "restored draft remains distinct from published revision",
      "document.querySelector('.brand-presets button.active')?.textContent.includes('Ботаника') && " +
      "document.querySelector('.brand-state')?.innerText.includes('Опубликовано · версия 1') && " +
      "document.body.innerText.includes('Версия черновика: 3.') && " +
      "document.body.innerText.includes('Текущий черновик ещё не опубликован.')");
    assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0,
      "Published appearance wrote browser storage");
    assert.equal(responses.filter((r) => r.status === 201 && r.path.endsWith("/locations")).length, 1);
    assert.equal(responses.filter((r) => r.status === 201 && r.path.endsWith("/shift-plans")).length, 1);
    assert.ok(responses.some((r) => r.status === 200 && r.path.endsWith("/workspace-overview")));
    assert.ok(responses.some((r) => r.status === 201 && r.path.endsWith("/services")));
    assert.ok(responses.some((r) => r.status === 201 && r.path.endsWith("/staff")));
    assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0, "Real mode wrote browser storage");
    await button(cdp, "Выйти");
    await requireDom(cdp, "server logout confirmed", "document.body.innerText.includes('Вы вышли') && !document.querySelector('.real-owner-nav')");
    assert.ok(responses.some((r) => r.status === 204 && r.path === "/v1/auth/logout"));
    const revoked = await pool.query(
      "SELECT count(*)::int AS count FROM cookie_identity.opaque_sessions WHERE tenant_id=$1::uuid AND revoked_at IS NOT NULL",
      [owner.tenantId],
    );
    assert.equal(revoked.rows[0]?.count, 1, "Logout did not revoke actual DB bearer");

    await stopServer(api);
    api = await startServer(env, origin);
    script = await loadAndEnterTelegram(cdp, origin, signedProof(botToken, userId), script, "business");
    await requireDom(cdp, "service persisted after process restart",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
    await button(cdp, "Оформление");
    await requireDom(cdp, "published appearance persists across API restart",
      "document.querySelector('.brand-presets button.active')?.textContent.includes('Ботаника') && " +
      "document.querySelector('.brand-state')?.innerText.includes('Опубликовано · версия 1') && " +
      "document.body.innerText.includes('Версия черновика: 3.') && " +
      "document.body.innerText.includes('Текущий черновик ещё не опубликован.')");
    const appearanceAfterRestart = await pool.query(
      "SELECT draft_revision::text, published_revision::text, published_config FROM cookie_appearance.organization_branding WHERE tenant_id=$1::uuid",
      [owner.tenantId]);
    assert.equal(appearanceAfterRestart.rows[0]?.draft_revision, "3");
    assert.equal(appearanceAfterRestart.rows[0]?.published_revision, "1");
    assert.equal(appearanceAfterRestart.rows[0]?.published_config.presetId, "forest");
    await button(cdp, "Мастера");
    await requireDom(cdp, "staff persisted after process restart",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    await requireOverview(cdp);
    await requireShift(cdp);
    assert.equal(await assertBranch(pool, owner), locationId);
    assert.equal(await assertPlan(pool, owner, beforeRestart.staffId, locationId, date), shiftId);
    await button(cdp, "Мастера");
    await requireDom(cdp, "staff after restart", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    for (const [width, height] of [[320, 568], [768, 900], [1280, 800]]) {
      await viewport(cdp, width, height);
      await checkWidth(cdp, "real staff " + width + "px");
      await checkLabeledControls(cdp, "real staff " + width + "px");
      await button(cdp, "Услуги");
      await requireDom(cdp, "service list at " + width, "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
      await checkWidth(cdp, "real services " + width + "px");
      if (width >= 681) {
        if (width === 1280) await viewport(cdp, width, 480);
        const trigger = ".sidebar-bottom .rhythm-popover-trigger";
        const target = await evaluate(cdp,
          "(() => {const b=document.querySelector(" + JSON.stringify(trigger) + ");if(!b)return null;const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return b.contains(document.elementFromPoint(x,y))?{x,y}:null;})()");
        assert.ok(target, "Workspace account must be clickable at " + width);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...target });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...target });
        await requireDom(cdp, "account menu opened and focused at " + width,
          "Boolean(document.activeElement?.closest('.workspace-account [popover]'))");
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await requireDom(cdp, "account menu closed and focus returned at " + width,
          "document.activeElement?.matches(" + JSON.stringify(trigger) + ") && !document.querySelector('.workspace-account [popover]')?.matches(':popover-open')");
        if (width === 1280) await viewport(cdp, width, height);
      }
      await requireOverview(cdp);
      await checkWidth(cdp, "real overview " + width + "px");
      await checkLabeledControls(cdp, "real overview " + width + "px");
      await requireShift(cdp);
      await checkWidth(cdp, "real schedule " + width + "px");
      await checkLabeledControls(cdp, "real schedule " + width + "px");
      await button(cdp, "Мастера");
      await requireDom(cdp, "staff list at " + width, "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    }
    assert.deepEqual(await assertStored(pool, owner, locationId), beforeRestart, "Restart changed persisted IDs");
    // No grant is implicit: a trusted operator explicitly grants a single
    // synthetic staging seat before the owner can perform the activation.
    await requireDom(cdp, "no staging grant", "document.body.innerText.includes('Оператор ещё не выдал тестовое разрешение')");
    await issueStagingGrant(pool, owner.tenantId, 1, new Date(Date.now()+3600000).toISOString());
    await button(cdp, "Обновить лимит");
    await requireDom(cdp, "staging seat available", "document.body.innerText.includes('Активных мастеров: 0 / 1')");
    await evaluate(cdp, "(() => {const panel=document.querySelector('[aria-label=\"Тестовая активация мастеров\"]');const s=panel.querySelector('select');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await requireDom(cdp, "staging selection", "document.querySelector('[aria-label=\"Тестовая активация мастеров\"] input[type=checkbox]')?.disabled===false");
    await evaluate(cdp, "document.querySelector('[aria-label=\"Тестовая активация мастеров\"] input[type=checkbox]').click()");
    await button(cdp, "Активировать для staging");
    await requireDom(cdp, "staging seat consumed", "document.body.innerText.includes('Активных мастеров: 1 / 1') && document.querySelector('.list-items')?.innerText.includes('Активирован')");
    const publication = await pool.query(
      "SELECT (SELECT count(*)::int FROM cookie_staff.staging_publication_receipts WHERE tenant_id=$1::uuid) AS receipts, (SELECT count(*)::int FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid AND active AND bookable) AS seats, (SELECT count(*)::int FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid AND active) AS shifts",
      [owner.tenantId],
    );
    assert.deepEqual(publication.rows[0], {receipts:1,seats:1,shifts:0});
    assert.ok(responses.some(r=>r.status===201&&r.path.endsWith("/staging-publication")));
    await checkWidth(cdp, "activated staging staff");
    await button(cdp, "Расписание");
    await requireDom(cdp, "draft ready for explicit publication", "document.querySelector('.schedule-summary')?.innerText.includes('Черновик') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Подготовить публикацию')");
    const scheduleReadsBeforeFilter = responses.filter(r=>r.path.endsWith("/shift-plans")||r.path.endsWith("/staging-shift-publication")||r.path.endsWith("/staff")||r.path.endsWith("/locations")).length;
    await fill(cdp, ".schedule-directory select:first-of-type", beforeRestart.staffId, "change");
    await requireDom(cdp, "staff schedule filter", "document.querySelector('.schedule-directory select').value==="+JSON.stringify(beforeRestart.staffId)+" && document.querySelector('.schedule-summary [data-component=RecordRow]')?.innerText.includes('Черновик')");
    await evaluate(cdp, "(()=>{const s=document.querySelectorAll('.schedule-directory select')[1];s.value=[...s.options].find(o=>o.value&&o.value!=="+JSON.stringify(locationId)+").value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await requireDom(cdp, "other branch has no matching draft", "document.querySelector('[data-component=EmptyState]')?.innerText.includes('Черновики не найдены') && !document.querySelector('.schedule-summary')");
    await button(cdp, "Сбросить фильтры");
    await requireDom(cdp, "schedule reset restores draft and publish action", "[...document.querySelectorAll('.schedule-directory select')].every(s=>s.value==='') && document.querySelector('.schedule-summary')?.innerText.includes('Черновик')");
    assert.equal(responses.filter(r=>r.path.endsWith("/shift-plans")||r.path.endsWith("/staging-shift-publication")||r.path.endsWith("/staff")||r.path.endsWith("/locations")).length,scheduleReadsBeforeFilter,"Schedule filtering must use existing reads");
    await button(cdp, "Подготовить публикацию");
    await requireDom(cdp, "confirmation before active shift", "document.querySelector('[aria-label=\"Подтверждение публикации смены\"]')");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid AND active",[owner.tenantId])).rows[0].count,0);
    await button(cdp, "Подтвердить публикацию");
    await requireDom(cdp, "published shift read after commit", "document.querySelector('.schedule-summary [data-component=ScheduleRow]')?.innerText.includes('Опубликована в тестовом контуре')");
    await evaluate(cdp, "(()=>{const s=document.querySelectorAll('.schedule-directory select')[1];s.value=[...s.options].find(o=>o.value&&o.value!=="+JSON.stringify(locationId)+").value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await requireDom(cdp, "published shift filter no match", "[...document.querySelectorAll('[data-component=EmptyState]')].some(e=>e.innerText.includes('Опубликованные смены не найдены')) && !document.querySelector('[data-component=ScheduleRow]')");
    await button(cdp, "Сбросить фильтры");
    await requireDom(cdp, "published shift reset", "document.querySelector('[data-component=ScheduleRow]')?.innerText.includes('Опубликована в тестовом контуре')");
    for (const [width,height] of [[320,568],[375,812],[768,900],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"RC9.4 schedule directory "+width+"px");
      await checkLabeledControls(cdp,"RC9.4 schedule directory "+width+"px");
    }
    await viewport(cdp,375,812);
    const shifts = await pool.query("SELECT id::text,active FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid",[owner.tenantId]);
    assert.equal(shifts.rowCount,1);
    assert.equal(shifts.rows[0].active,true);
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-shift-publication")));
    await requireDom(cdp,"server preview controls","document.querySelector('[aria-label=\"Предпросмотр записи staging\"] select')?.options.length===2");
    await evaluate(cdp,"(() => {const p=document.querySelector('[aria-label=\"Предпросмотр записи staging\"]');const s=p.querySelector('select');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));const d=p.querySelector('input[type=date]');d.value="+JSON.stringify(date)+";d.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await button(cdp,"Проверить слоты");
    await requireDom(cdp,"server calculated preview","document.body.innerText.includes('Найдено слотов: 29.')");
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-availability")));
    await viewport(cdp,375,812);
    await checkWidth(cdp,"real availability 375px");
    await checkWidth(cdp, "published staging schedule");
    await checkLabeledControls(cdp, "published staging schedule");
    await button(cdp, "Выйти");
    await requireDom(cdp, "logout before shift persistence check", "document.body.innerText.includes('Вы вышли')");
    await stopServer(api);
    api = await startServer(env, origin);
    script = await loadAndEnterTelegram(cdp, origin, signedProof(botToken, userId), script, "business");
    await requireDom(cdp, "authenticated after schedule restart", "document.querySelector('.real-owner-nav')");
    await button(cdp,"Расписание");
    await requireDom(cdp,"published shift persisted after restart","document.querySelector('.schedule-summary')?.innerText.includes('Опубликована в тестовом контуре')");
    assert.deepEqual((await pool.query("SELECT id::text,active FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid",[owner.tenantId])).rows,shifts.rows);

    assert.deepEqual(shifts.rows,[{id:shiftId,active:true}],"Existing draft must be published, not replaced");
    await button(cdp, "Выйти");
    await requireDom(cdp, "owner logout before customer", "document.body.innerText.includes('Вы вышли')");
    const customerUserId = userId + 1000000000;
    await provisionStagingCustomer(pool,createTelegramMiniAppProofVerifier({botToken,maxAgeSeconds:300}),userHashSecret,{
      tenantId:owner.tenantId,rawInitData:signedProof(botToken,customerUserId),consentConfirmed:true,
    });
    const beforeWrongRole=responses.length;
    script=await loadAndEnterTelegram(cdp,origin,signedProof(botToken,customerUserId),script,"business");
    await requireDom(cdp,"legacy client rejected from business workspace",
      "document.body.innerText.includes('Не удалось подтвердить вход') && !document.querySelector('.real-owner-nav')");
    assert.ok(responses.slice(beforeWrongRole).some(r=>r.status===403&&r.path.endsWith("/session-context")));
    script=await loadAndEnterTelegram(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script,"customer");
    await requireDom(cdp,"verified client context","document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.innerText==='Вход клиента подтверждён' && !document.querySelector('.real-owner-nav')");
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-context")));
    await checkWidth(cdp,"real client context");
    const panel='[aria-label="Клиентская витрина staging"]';
    const serviceChoice = "document.querySelector("+JSON.stringify(panel+" [data-component=ChoiceList] button")+")";
    await requireDom(cdp,"published client catalog",serviceChoice);
    await requireDom(cdp,"future booking steps and continue unavailable",
      "document.querySelectorAll("+JSON.stringify(panel+" .rhythm-steps button:disabled")+")?.length===3 && [...document.querySelectorAll("+JSON.stringify(panel+" button")+ ")].some(b=>b.textContent.trim()==='Продолжить'&&b.disabled)");
    await fill(cdp, panel+" input[type=search]", "несуществующая услуга");
    await requireDom(cdp,"no matching services","document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Услуги по вашему запросу не найдены')");
    await fill(cdp, panel+" input[type=search]", "");
    await requireDom(cdp,"service returns after clearing search",serviceChoice);
    await evaluate(cdp,serviceChoice+".click()");
    await button(cdp,"Продолжить");
    await requireDom(cdp,"next step heading receives focus",
      "document.activeElement?.matches("+JSON.stringify(panel+" [data-component=BookingLayout] h2")+") && document.activeElement.textContent==='Филиал и мастер'");
    const choiceSelector = label => panel+' [data-component="ChoiceList"][aria-label="'+label+'"] button[data-component="ChoiceRow"]';
    const chooseBranchAndStaff = async () => {
      for (const label of ["Филиал", "Мастер"]) {
        const selector = choiceSelector(label);
        await requireDom(cdp,"available selection "+label,
          "document.querySelectorAll("+JSON.stringify(selector)+").length===1 && !document.querySelector("+JSON.stringify(selector)+").disabled");
        await evaluate(cdp,"document.querySelector("+JSON.stringify(selector)+").click()");
        await requireDom(cdp,"selected "+label,
          "document.querySelector("+JSON.stringify(selector+"[aria-pressed=true]")+")");
      }
    };
    await requireDom(cdp,"staff hidden before branch","!document.querySelector("+JSON.stringify(choiceSelector("Мастер"))+")");
    await chooseBranchAndStaff();
    for (const [width,height] of [[320,568],[375,812],[768,900],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"branch and staff choices "+width+"px");
      await checkLabeledControls(cdp,"branch and staff choices "+width+"px");
    }
    await viewport(cdp,375,812);
    await button(cdp,"Продолжить");
    await requireDom(cdp,"client date enabled","!document.querySelector("+JSON.stringify(panel+" input[type=date]")+")?.disabled");
    await evaluate(cdp,"(()=>{const d=document.querySelector("+JSON.stringify(panel+" input[type=date]")+");d.value="+JSON.stringify(date)+";d.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await button(cdp,"Найти свободное время");
    await requireDom(cdp,"real customer slots","document.querySelectorAll("+JSON.stringify(panel+" .customer-slot-choice")+")?.length===29");
    await evaluate(cdp,"document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+").click()");
    await evaluate(cdp,"document.querySelectorAll("+JSON.stringify(panel+" .rhythm-steps button") + ")[1].click()");
    const selectedChoices = "[...document.querySelectorAll("+JSON.stringify(panel+' [data-component="ChoiceRow"][aria-pressed="true"]')+")].map(b=>b.textContent.trim())";
    await requireDom(cdp,"selected branch and staff preserved on back",selectedChoices+".length===2");
    const chosenBranchAndStaff = await evaluate(cdp,selectedChoices);
    // Re-selecting an already selected branch must not clear valid downstream state.
    await evaluate(cdp,"document.querySelector("+JSON.stringify(choiceSelector("Филиал")+"[aria-pressed=true]")+").click()");
    assert.deepEqual(await evaluate(cdp,selectedChoices),chosenBranchAndStaff);
    await button(cdp,"Продолжить");
    await requireDom(cdp,"selected time preserved on return",
      "document.querySelector("+JSON.stringify(panel+" .customer-slot-choice[aria-pressed=true]")+")");
    await evaluate(cdp,"document.querySelectorAll("+JSON.stringify(panel+" .rhythm-steps button") + ")[1].click()");
    assert.deepEqual(await evaluate(cdp,
      selectedChoices), chosenBranchAndStaff);
    await button(cdp,"Продолжить");
    await button(cdp,"Продолжить");
    await requireDom(cdp,"slot is not reserved","document.querySelector("+JSON.stringify(panel+" .customer-choice-summary")+")?.innerText.includes('Время не забронировано')");
    for (const [width, height] of [[320, 568], [375, 812], [768, 900], [1280, 800]]) {
      await viewport(cdp, width, height);
      await checkWidth(cdp, "booking review " + width + "px");
      await checkLabeledControls(cdp, "booking review " + width + "px");
      await requireDom(cdp, "booking review retained at " + width,
        "document.querySelector("+JSON.stringify(panel+" [aria-current=step]")+")?.innerText.includes('Проверка') && document.querySelector("+JSON.stringify(panel+" [data-component=BookingTicket]")+")");
    }
    await viewport(cdp, 375, 812);
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-offers")));
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-slots")));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM cookie_booking.bookings WHERE tenant_id=$1::uuid",[owner.tenantId])).rows[0].count,0);
    await checkWidth(cdp,"real customer offers");
    await checkLabeledControls(cdp,"real customer offers");
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    await button(cdp,"Выйти");
    await requireDom(cdp,"customer logout","document.body.innerText.includes('Вход клиента') && !document.querySelector('section[aria-label=\"Клиентская витрина staging\"]')");
    script=await loadAndEnterTelegram(cdp,origin+"?surface=customer-staging",signedProof(botToken,userId),script,"customer");
    await requireDom(cdp,"owner rejected on client surface","document.body.innerText.includes('Не удалось подтвердить вход') && !document.querySelector('section[aria-label=\"Клиентская витрина staging\"]')");
    assert.ok(!(await evaluate(cdp,"Boolean(document.querySelector('.real-owner-nav'))")));
    assert.deepEqual(external, [], "Unexpected real-mode external network requests");
    assert.deepEqual(errors, [], "Unexpected browser runtime errors");
    // Main's suspended-tab expiry contract also applies to the client surface.
    script=await loadAndEnterTelegram(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script,"customer");
    await requireDom(cdp,"client catalog before local expiry",serviceChoice);
    await evaluate(cdp,"window.__cookieTestClockMs=3600001;document.dispatchEvent(new Event('visibilitychange'));");
    await requireDom(cdp,"client fails closed on local expiry","!document.querySelector("+JSON.stringify(panel)+") && document.body.innerText.includes('Вход клиента') && !document.querySelector('.real-owner-nav')");
    script=await loadAndEnterTelegram(cdp,origin,signedProof(botToken,userId),script,"business");
    await requireDom(cdp,"owner for calendar","document.querySelector('.real-owner-nav')");
    // The production write API remains absent. Seed exactly one synthetic
    // persisted Booking in this isolated CI database to test read-only Calendar.
    await button(cdp,"Календарь");
    await requireDom(cdp,"empty real owner calendar","document.querySelector('.empty-mini')?.innerText.includes('За выбранный период записей нет')");
    const customerId = randomUUID();
    const bookingId = randomUUID();
    await pool.query("INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1,$2)",[owner.tenantId,customerId]);
    await pool.query(
      `INSERT INTO cookie_booking.bookings (tenant_id,id,customer_id,staff_id,location_id,service_id,status,start_at,end_at,occupied_until,service_duration_minutes_snapshot,post_service_buffer_minutes_snapshot,price_kopecks_snapshot)
       VALUES($1,$2,$3,$4,$5,$6,'Confirmed',$7::timestamptz,$7::timestamptz+interval '50 minutes',$7::timestamptz+interval '50 minutes',50,0,125050)`,
      [owner.tenantId,bookingId,customerId,beforeRestart.staffId,locationId,beforeRestart.serviceId,date+"T06:00:00Z"],
    );
    await evaluate(cdp,"(()=>{const s=document.querySelector(\'.owner-calendar select\');s.value="+JSON.stringify(locationId)+";s.dispatchEvent(new Event(\'change\',{bubbles:true}));})()");
    await requireDom(cdp,"calendar branch loaded","document.querySelector(\'.owner-calendar input[type=date]\')?.disabled===false && document.querySelector(\'.owner-calendar select\')?.value==="+JSON.stringify(locationId));
    await fill(cdp,".owner-calendar input[type=date]",date,"change");
    await requireDom(cdp,"calendar reads persisted Booking","document.querySelector('[aria-label=\"Записи за выбранный период\"]')?.innerText.includes('Synthetic E2E Edited Service') && document.querySelector('.status-pill')?.innerText.includes('Подтверждена')");
    await requireDom(cdp,"day uses real staff resource group","document.querySelector('.owner-calendar-group h3')?.innerText==='Synthetic E2E Staff' && document.querySelectorAll('.owner-calendar-group').length===1");
    await button(cdp,"Неделя");
    await requireDom(cdp,"week reads persisted Booking","document.querySelector('[aria-label=\"Записи за выбранный период\"]')?.innerText.includes('Synthetic E2E Staff')");
    await requireDom(cdp,"seven local day groups without duplicate booking","document.querySelectorAll('.owner-calendar-group').length===7 && document.querySelectorAll('.owner-calendar-group [data-booking-id]').length===1");
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/owner-calendar")));
    await verifyOwnerBookingDetail(cdp, responses, {
      bookingId, duration: 50, buffer: 0, priceKopecks: "125050",
      status: "Подтверждена", tenantId: owner.tenantId, viewport, testLatePeriod: true,
    });
    for(const [width,height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"real owner calendar "+width+"px");
      await checkLabeledControls(cdp,"real owner calendar "+width+"px");
    }


    await button(cdp, "Выйти");
    await requireDom(cdp, "calendar owner logout", "document.body.innerText.includes('Вы вышли')");
    // Launch a fresh verified session, then simulate tab resume after local expiry.
    script = await loadAndEnterTelegram(cdp, origin, signedProof(botToken, userId), script, "business");
    await requireDom(cdp, "fresh session for expiry", "document.querySelector('.real-owner-nav') && document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
    await button(cdp, "Мастера");
    await requireDom(cdp, "protected staff before expiry", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    await evaluate(cdp, "window.__cookieTestClockMs=3600001;document.dispatchEvent(new Event('visibilitychange'));");
    await requireDom(cdp, "cabinet fails closed on local session expiry", "document.body.innerText.includes('Срок действия сеанса истёк') && !document.querySelector('.real-owner-nav') && !document.body.innerText.includes('Synthetic E2E Staff')");
    assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0);
    assert.deepEqual(errors, [], "Unexpected browser runtime errors after expiry");
    assert.deepEqual(external, [], "Unexpected external requests after expiry");
    // The previous browser path proved default-off. Restart with the separate
    // write switch only in this isolated synthetic CI process.
    await stopServer(api);
    api = await startServer({ ...env, COOKIE_STAGING_CUSTOMER_BOOKING_MODE: "enabled", COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES: "60", COOKIE_STAGING_CUSTOMER_RESCHEDULE_CUTOFF_MINUTES: "30" }, origin);
    script = await loadAndEnterTelegram(cdp, origin+"?surface=customer-staging", signedProof(botToken,customerUserId), script, "customer");
    await requireDom(cdp,"write-enabled customer catalog",serviceChoice);
    await evaluate(cdp,serviceChoice+".click()");
    await button(cdp,"Продолжить");
    await chooseBranchAndStaff();
    await button(cdp,"Продолжить");
    await fill(cdp,panel+" input[type=date]",date,"change");
    await button(cdp,"Найти свободное время");
    await requireDom(cdp,"slots before actual booking","document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+")");
    await evaluate(cdp,"document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+").click()");
    await button(cdp,"Продолжить");
    await requireDom(cdp,"real write button","Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Записаться'&&!b.disabled)");
    // Dispatch two clicks in the same browser task, before Svelte can flush.
    // Count actual POSTs rather than relying only on the persisted row count.
    await evaluate(cdp,"(()=>{const send=window.fetch.bind(window);window.__rc94CreateRequests=0;window.fetch=(input,init)=>{if(init?.method==='POST'&&String(input).endsWith('/staging-customer-bookings'))window.__rc94CreateRequests++;return send(input,init);};const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Записаться'&&!b.disabled);b.click();b.click();})()");
    await requireDom(cdp,"server-confirmed real booking","document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Создание записи подтверждено') && document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Фактическая стоимость')");
    await requireDom(cdp,"confirmation replaces booking steps and receives focus",
      "!document.querySelector("+JSON.stringify(panel+" [data-component=BookingLayout]")+") && document.activeElement?.matches("+JSON.stringify(panel+" .customer-choice-summary")+")");
    assert.equal(await evaluate(cdp,"window.__rc94CreateRequests"),1,"Same-task double click must produce one Create request");
    const realBooking = await pool.query(
      "SELECT b.id::text,b.status,b.price_kopecks_snapshot::text AS price FROM cookie_booking.bookings b JOIN cookie_customers.staging_customer_identities c ON c.tenant_id=b.tenant_id AND c.customer_id=b.customer_id WHERE b.tenant_id=$1::uuid",
      [owner.tenantId],
    );
    assert.equal(realBooking.rowCount,1);
    assert.equal(realBooking.rows[0].status,"Confirmed");
    assert.equal(realBooking.rows[0].price,"125050");
    const historyPanel = '[aria-label="Мои записи"]';
    const historyContains = "document.querySelector("+JSON.stringify(historyPanel)+")?.innerText.includes("+JSON.stringify(realBooking.rows[0].id)+")";
    await requireDom(cdp,"own persisted booking in cabinet",historyContains);
    await button(cdp,"Обновить записи");
    await requireDom(cdp,"server history after refresh",historyContains);
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-history")));
    assert.ok(responses.some(r=>r.status===201&&r.path.endsWith("/staging-customer-bookings")));
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0,"Confirmed attempt marker must be removed");
    for(const [width,height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"confirmed customer booking "+width+"px");
    }
    // Independent real-browser customer reschedule path: the same Confirmed
    // Booking changes only its UTC minute, not ID, service/staff/location,
    // price snapshot, or customer. All evidence is from live PostgreSQL.
    await requireDom(cdp, "real client move action", "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Перенести запись'&&!b.disabled)");
    const beforeMove = await pool.query(
      "SELECT start_at,price_kopecks_snapshot::text AS price,service_id::text AS service,staff_id::text AS staff,location_id::text AS location FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [owner.tenantId, realBooking.rows[0].id],
    );
    assert.equal(beforeMove.rowCount, 1);
    const moveAt = date + "T10:00:00.000Z";
    assert.notEqual(beforeMove.rows[0].start_at.toISOString(), moveAt);
    await button(cdp, "Перенести запись");
    await requireDom(cdp, "server-local staging date and verified available slot",
      "(()=>{const panel=document.querySelector(" + JSON.stringify(historyPanel) + ");const datePicker=panel?.querySelector('input[type=date]');const select=panel?.querySelector('select');return datePicker?.value===" + JSON.stringify(date) +
      " && !panel.querySelector('input[type=datetime-local]') && [...(select?.options??[])].some(option=>option.value===" + JSON.stringify(moveAt) + ");})()");
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-reschedule/"+realBooking.rows[0].id+"/slots")));
    await evaluate(cdp, "(()=>{const s=document.querySelector(" + JSON.stringify(historyPanel+" select") + ");s.value=" + JSON.stringify(moveAt) + ";s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await requireDom(cdp, "move selection is exactly a server-provided UTC instant",
      "document.querySelector(" + JSON.stringify(historyPanel+" select") + ")?.value===" + JSON.stringify(moveAt));
    for(const [width,height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"client branch-local slots "+width+"px");
      await checkLabeledControls(cdp,"client branch-local slots "+width+"px");
    }
    await button(cdp, "Проверить новое время");
    await requireDom(cdp, "explicit branch-zone move confirmation",
      "document.body.innerText.includes('Подтвердить перенос') && document.body.innerText.includes('исходная стоимость сохранятся')");
    const clientMoveUrl="/v1/organizations/"+owner.tenantId+"/staging-customer-reschedule/"+realBooking.rows[0].id;
    let clientMoveRequests=0;
    cdp.onEvent("Network.requestWillBeSent",({request})=>{
      if(request.url.startsWith(origin)&&request.method==="POST"&&new URL(request.url).pathname===clientMoveUrl)clientMoveRequests++;
    });
    // Only the first and final POST reach the server. Simulated intermediate
    // rejections test uncertainty handling, not actual permission revocation.
    await evaluate(cdp,"(()=>{const send=window.fetch.bind(window);let lost=false;window.__kukiClientMoveKeys=[];window.__kukiClientMoveBodies=[];window.__kukiClientMoveRejections=[];window.__kukiClientMoveNext=null;window.fetch=async(input,init)=>{if(init?.method==='POST'&&String(input).split('?')[0].endsWith("+JSON.stringify(clientMoveUrl)+")){window.__kukiClientMoveKeys.push(new Headers(init.headers).get('idempotency-key'));window.__kukiClientMoveBodies.push(init.body);const rejection=window.__kukiClientMoveNext;if(rejection!==null){window.__kukiClientMoveNext=null;window.__kukiClientMoveRejections.push(rejection.status);return Response.json({error:rejection.code},{status:rejection.status});}const reply=await send(input,init);if(!lost&&reply.status===200){lost=true;throw new Error('synthetic lost customer move response');}return reply;}return send(input,init);};})()");
    await button(cdp, "Подтвердить перенос");
    const clientMoveUnknown="document.querySelector("+JSON.stringify(historyPanel)+")";
    await requireDom(cdp,"client move commit not acknowledged",
      clientMoveUnknown+"?.innerText.includes('Результат переноса не подтверждён')&&[..."+clientMoveUnknown+".querySelectorAll('button')].some(b=>b.textContent.trim()==='Повторить исходный перенос'&&!b.disabled)&&!"+clientMoveUnknown+".innerText.includes('Перенос подтверждён сервером')");
    const readCommittedMove=()=>pool.query(
      "SELECT start_at,price_kopecks_snapshot::text AS price,service_id::text AS service,staff_id::text AS staff,location_id::text AS location,status FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [owner.tenantId,realBooking.rows[0].id],
    );
    const readMoveEffects=async()=> (await pool.query(
      "SELECT (SELECT count(*)::int FROM cookie_booking.time_change_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.reschedule') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.rescheduled' AND payload->>'bookingId'=$2::text) AS events",
      [owner.tenantId,realBooking.rows[0].id],
    )).rows[0];
    const committedClientMove=await readCommittedMove();
    assert.equal(committedClientMove.rowCount,1);
    assert.equal(committedClientMove.rows[0].start_at.toISOString(),moveAt);
    assert.equal(committedClientMove.rows[0].status,"Confirmed");
    assert.deepEqual(await readMoveEffects(),{audits:1,receipts:1,events:1});
    assert.equal(clientMoveRequests,1,"Unknown move must not auto-retry");
    const rejectedMoves=[{status:409,code:"RESCHEDULE_CONFLICT"},{status:404,code:"BOOKING_NOT_FOUND"},{status:403,code:"forbidden"}];
    for(const [i,rejection] of rejectedMoves.entries()){
      const retryMarker=responses.length;
      await evaluate(cdp,"window.__kukiClientMoveNext="+JSON.stringify(rejection));
      await button(cdp,"Повторить исходный перенос");
      await requireDom(cdp,"customer move remains unknown after synthetic "+rejection.status,
        "window.__kukiClientMoveRejections.length==="+(i+1)+"&&"+clientMoveUnknown+"?.innerText.includes('Результат исходного переноса не подтверждён')&&[..."+clientMoveUnknown+".querySelectorAll('button')].some(b=>b.textContent.trim()==='Повторить исходный перенос'&&!b.disabled)&&!"+clientMoveUnknown+".innerText.includes('Перенос не выполнен')&&!"+clientMoveUnknown+".innerText.includes('Перенос подтверждён сервером')");
      if(rejection.status===403){
        assert.ok(responses.slice(retryMarker).some(r=>r.path.endsWith("/staging-customer-history")&&r.status===200),"Denied retry must revalidate the still-authorized customer context");
      }
      assert.equal(clientMoveRequests,1,"Synthetic rejection must not reach server");
      const keys=await evaluate(cdp,"window.__kukiClientMoveKeys");
      const bodies=await evaluate(cdp,"window.__kukiClientMoveBodies");
      assert.equal(keys.length,i+2);
      assert.ok(keys.every(key=>key===keys[0]));
      assert.equal(bodies.length,i+2);
      assert.ok(bodies.every(body=>body===bodies[0]));
      assert.deepEqual((await readCommittedMove()).rows,committedClientMove.rows);
      assert.deepEqual(await readMoveEffects(),{audits:1,receipts:1,events:1});
    }
    assert.deepEqual(await evaluate(cdp,"window.__kukiClientMoveRejections"),[409,404,403]);
    await button(cdp,"Повторить исходный перенос");
    await requireDom(cdp, "confirmed time-only move in customer cabinet",
      "document.querySelector(" + JSON.stringify(historyPanel) + ")?.innerText.includes('Перенос подтверждён сервером') && [...document.querySelectorAll('.customer-history li time')].some(t=>t.dateTime===" + JSON.stringify(moveAt) + ")");
    const afterMove = await pool.query(
      "SELECT start_at,price_kopecks_snapshot::text AS price,service_id::text AS service,staff_id::text AS staff,location_id::text AS location,status FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [owner.tenantId, realBooking.rows[0].id],
    );
    assert.equal(afterMove.rowCount, 1);
    assert.equal(afterMove.rows[0].start_at.toISOString(), moveAt);
    assert.equal(afterMove.rows[0].price, beforeMove.rows[0].price);
    for (const field of ["service", "staff", "location"])
      assert.equal(afterMove.rows[0][field], beforeMove.rows[0][field]);
    assert.equal(afterMove.rows[0].status, "Confirmed");
    const moveEvidence = await pool.query(
      "SELECT (SELECT count(*)::int FROM cookie_booking.time_change_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits, (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.reschedule') AS receipts, (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.rescheduled' AND payload->>'bookingId'=$2::text) AS events",
      [owner.tenantId, realBooking.rows[0].id],
    );
    assert.deepEqual(moveEvidence.rows[0], { audits: 1, receipts: 1, events: 1 });
    assert.equal(clientMoveRequests,2,"Only original and final replay may reach server");
    const clientMoveKeys=await evaluate(cdp,"window.__kukiClientMoveKeys");
    const clientMoveBodies=await evaluate(cdp,"window.__kukiClientMoveBodies");
    assert.equal(clientMoveKeys.length,5);
    assert.equal(typeof clientMoveKeys[0],"string");
    assert.ok(clientMoveKeys[0].length>=16);
    assert.ok(clientMoveKeys.every(key=>key===clientMoveKeys[0]));
    assert.equal(clientMoveBodies.length,5);
    assert.ok(clientMoveBodies.every(body=>body===clientMoveBodies[0]));
    assert.deepEqual(JSON.parse(clientMoveBodies[0]),{newStartAt:moveAt});
    assert.deepEqual(afterMove.rows,committedClientMove.rows);
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-reschedule/"+realBooking.rows[0].id)));
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    for(const [width,height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"confirmed client move "+width+"px");
      await checkLabeledControls(cdp,"confirmed client move "+width+"px");
    }
    console.log("PASS real customer browser time-only move: unchanged Booking ID, price, service, staff and location, one audit/receipt/outbox.");
    await requireDom(cdp,"real cancel action","Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Отменить запись'&&!b.disabled)");
    await button(cdp,"Отменить запись");
    await button(cdp,"Подтвердить отмену");
    await requireDom(cdp,"confirmed persisted cancellation","document.querySelector("+JSON.stringify(historyPanel)+")?.innerText.includes('Отменена клиентом')");
    const realCancelled=await pool.query("SELECT status FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",[owner.tenantId,realBooking.rows[0].id]);
    assert.deepEqual(realCancelled.rows,[{status:"CancelledByClient"}]);
    const receiptCard = "document.querySelector("+JSON.stringify(panel+" .customer-choice-summary")+")";
    await requireDom(cdp,"creation receipt no longer presents cancelled booking as active",
      receiptCard+"?.innerText.includes('Запись изменена после создания') && !"+receiptCard+"?.innerText.includes('Время при создании') && !"+receiptCard+"?.innerText.includes('Статус на момент обновления списка: подтверждена')");
    await button(cdp,"Создать ещё запись");
    await requireDom(cdp,"new selection returns to live catalog after cancellation",
      serviceChoice+" && !"+receiptCard);
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0,"Cancellation must not create a pending Create marker");
    await evaluate(cdp,serviceChoice+".click()");
    await button(cdp,"Продолжить");
    await chooseBranchAndStaff();
    await button(cdp,"Продолжить");
    await fill(cdp,panel+" input[type=date]",date,"change");
    await button(cdp,"Найти свободное время");
    await requireDom(cdp,"slots before lost response","document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+")");
    await evaluate(cdp,"document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+").click()");
    await button(cdp,"Продолжить");
    await requireDom(cdp,"second write available","Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Записаться'&&!b.disabled)");
    // Drop the real response only after the server has returned 201.
    await evaluate(cdp,"(()=>{const send=window.fetch.bind(window);window.fetch=async(input,init)=>{const response=await send(input,init);if(init?.method==='POST'&&String(input).endsWith('/staging-customer-bookings')&&response.status===201)throw new Error('synthetic lost response');return response;};})()");
    await button(cdp,"Записаться");
    await requireDom(cdp,"uncertain actual committed result","document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Статус записи не подтверждён')");
    await requireDom(cdp,"uncertain booking locks step navigation",
      "[...document.querySelectorAll("+JSON.stringify(panel+" .rhythm-steps button")+")].every(b=>b.disabled)");
    assert.equal(await evaluate(cdp,"sessionStorage.length"),1);
    const beforeRecovery=await pool.query("SELECT b.id::text FROM cookie_booking.bookings b JOIN cookie_customers.staging_customer_identities c ON c.tenant_id=b.tenant_id AND c.customer_id=b.customer_id WHERE b.tenant_id=$1 AND b.status='Confirmed'",[owner.tenantId]);
    assert.equal(beforeRecovery.rowCount,1,"Real second booking must already be committed");
    const successfulCreates=responses.filter(r=>r.status===201&&r.path.endsWith("/staging-customer-bookings")).length;
    const recoveryPostCount = customerCreateRequests;
    const recoveryProjection = () => pool.query(
      `SELECT
         (SELECT count(*)::int FROM cookie_booking.bookings WHERE tenant_id=$1::uuid) AS bookings,
         (SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND operation='booking.create') AS receipts,
         (SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.confirmed') AS events`,
      [owner.tenantId],
    );
    const beforeProjection = await recoveryProjection();
    script=await loadAndEnterTelegram(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script,"customer");
    await requireDom(cdp,"reload retains unresolved marker","document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Статус предыдущей попытки неизвестен')");
    await button(cdp,"Найти подтверждение записи");
    await requireDom(cdp,"receipt recovered by same key","document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Восстановлено по исходной операции')&&document.querySelector("+JSON.stringify(panel)+")?.innerText.includes("+JSON.stringify(beforeRecovery.rows[0].id)+")");
    assert.equal(await evaluate(cdp,"sessionStorage.length"),0);
    assert.equal(responses.filter(r=>r.status===201&&r.path.endsWith("/staging-customer-bookings")).length,successfulCreates);
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-bookings/receipt")));
    const afterRecovery=await pool.query("SELECT b.id::text FROM cookie_booking.bookings b JOIN cookie_customers.staging_customer_identities c ON c.tenant_id=b.tenant_id AND c.customer_id=b.customer_id WHERE b.tenant_id=$1 AND b.status='Confirmed'",[owner.tenantId]);
    assert.deepEqual(afterRecovery.rows,beforeRecovery.rows);
    assert.equal(customerCreateRequests,recoveryPostCount,"Receipt recovery must not send any Create POST, including failed requests");
    assert.deepEqual((await recoveryProjection()).rows,beforeProjection.rows,"Recovery must leave durable bookings, create receipts and outbox counts unchanged");
    await checkWidth(cdp,"cancelled customer booking");

    // The recovered second real Booking must survive a new API process and
    // freshly authenticated client/owner reads, not just a browser reload.
    const restartBookingId = beforeRecovery.rows[0].id;
    const durableBooking = async () => {
      const result = await pool.query(
        `SELECT
          (SELECT to_jsonb(b) FROM cookie_booking.bookings b
            WHERE b.tenant_id=$1::uuid AND b.id=$2::uuid) AS booking,
          (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.operation,r.key_sha256),'[]'::jsonb)
            FROM cookie_booking.command_receipts r
            WHERE r.tenant_id=$1::uuid AND r.booking_id=$2::uuid) AS receipts,
          (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb)
            FROM cookie_jobs.outbox_events e
            WHERE e.tenant_id=$1::uuid AND e.payload->>'bookingId'=($2::uuid)::text) AS events,
          (SELECT count(*)::int FROM cookie_booking.bookings b
            WHERE b.tenant_id=$1::uuid) AS tenant_count`,
        [owner.tenantId, restartBookingId],
      );
      return result.rows[0];
    };
    // Separate real authorization regression on the recovered second Booking.
    // First attempt loses transport BEFORE any server write; then revoke the
    // actual customer role and retry. The original booking must be untouched.
    const beforeDeniedMove=await durableBooking();
    await requireDom(cdp,"second booking ready for revocation during unknown move",
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Перенести запись'&&!b.disabled)");
    await button(cdp,"Перенести запись");
    const revokeMoveSelect=historyPanel+" select";
    await requireDom(cdp,"actual available slots for revoked move",
      "document.querySelector("+JSON.stringify(revokeMoveSelect)+")?.options.length>1");
    await evaluate(cdp,"(()=>{const s=document.querySelector("+JSON.stringify(revokeMoveSelect)+");s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await button(cdp,"Проверить новое время");
    const deniedMoveUrl="/v1/organizations/"+owner.tenantId+"/staging-customer-reschedule/"+restartBookingId;
    await evaluate(cdp,"(()=>{const send=window.fetch.bind(window);window.fetch=async(input,init)=>{if(init?.method==='POST'&&String(input).split('?')[0].endsWith("+JSON.stringify(deniedMoveUrl)+")){window.fetch=send;throw new TypeError('synthetic offline before move');}return send(input,init);};})()");
    const beforeUnknownMove=responses.length;
    await button(cdp,"Подтвердить перенос");
    await requireDom(cdp,"second move unknown before revocation",
      "document.body.innerText.includes('Результат переноса не подтверждён')&&[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Повторить исходный перенос'&&!b.disabled)");
    assert.deepEqual(await durableBooking(),beforeDeniedMove);
    assert.equal(responses.slice(beforeUnknownMove).filter(r=>r.path===deniedMoveUrl).length,0);
    const revokedMoveRoles=await pool.query(
      `UPDATE cookie_identity.role_assignments a SET active=false
       FROM cookie_identity.roles r,cookie_customers.staging_customer_identities c
       WHERE a.tenant_id=$1::uuid AND c.tenant_id=a.tenant_id
         AND c.identity_id=a.identity_id AND r.tenant_id=a.tenant_id
         AND r.id=a.role_id AND r.base_type='client' AND a.active
       RETURNING a.id::text`,[owner.tenantId]);
    assert.equal(revokedMoveRoles.rowCount,1);
    try {
      const deniedMarker=responses.length;
      await button(cdp,"Повторить исходный перенос");
      await poll("actual denied customer move retry",()=>responses.slice(deniedMarker).some(r=>r.path===deniedMoveUrl&&(r.status===401||r.status===403)));
      await poll("authoritative customer history denial after retry",()=>responses.slice(deniedMarker).some(r=>r.path.endsWith("/staging-customer-history")&&(r.status===401||r.status===403)));
      await requireDom(cdp,"revoked customer move closes protected history and catalog",
        "!document.querySelector("+JSON.stringify(historyPanel)+")&&!document.querySelector("+JSON.stringify(panel)+")&&!document.body.innerText.includes('Перенос подтверждён сервером')");
      assert.deepEqual(await durableBooking(),beforeDeniedMove);
      assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    } finally {
      await pool.query("UPDATE cookie_identity.role_assignments SET active=true WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])",[owner.tenantId,revokedMoveRoles.rows.map(r=>r.id)]);
    }
    console.log("PASS customer unknown move: actual role revocation denied retry and history, protected UI cleared, no mutation.");
    script=await loadAndEnterTelegram(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script,"customer");
    await requireDom(cdp,"customer reauthenticated after synthetic role restoration",
      "document.querySelector("+JSON.stringify(historyPanel)+")?.innerText.includes("+JSON.stringify(restartBookingId)+")");
    const beforeBookingRestart = await durableBooking();
    assert.equal(beforeBookingRestart.booking.id, restartBookingId);
    assert.equal(beforeBookingRestart.booking.status, "Confirmed");
    assert.equal(beforeBookingRestart.tenant_count, 3, "Expected seeded, cancelled and recovered Booking");
    assert.equal(beforeBookingRestart.receipts.length, 1);
    assert.equal(beforeBookingRestart.receipts[0].operation, "booking.create");
    assert.equal(beforeBookingRestart.events.length, 1);
    assert.equal(beforeBookingRestart.events[0].topic, "booking.confirmed");
    const originalReceipt = beforeBookingRestart.receipts[0].result;
    assert.equal(originalReceipt.bookingId, restartBookingId);
    assert.equal(originalReceipt.priceKopecks, "125050");
    const restartStart = new Date(originalReceipt.startAt).toISOString();
    const restartEnd = new Date(originalReceipt.endAt).toISOString();
    const writesBeforeRestart = customerCreateRequests;
    const customerLogoutResponseStart = responses.length;
    await button(cdp, "Выйти");
    await poll("customer logout is acknowledged before Booking restart", () =>
      responses.slice(customerLogoutResponseStart).some((r) =>
        ["/v1/auth/identity/logout", "/v1/auth/logout"].includes(r.path) &&
          r.status === 204,
      ),
    );
    await requireDom(
      cdp,
      "customer logout closes private data before Booking restart",
      "!document.querySelector('[aria-label=\\\"Мои записи\\\"]') && !document.querySelector('[aria-label=\\\"Клиентская витрина staging\\\"]') && !document.body.innerText.includes('Вход клиента подтверждён')",
    );
    await stopServer(api);
    api = await startServer({ ...env, COOKIE_STAGING_CUSTOMER_BOOKING_MODE: "enabled", COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES: "60", COOKIE_STAGING_CUSTOMER_RESCHEDULE_CUTOFF_MINUTES: "30" }, origin);

    const historyResponseStart = responses.length;
    script = await loadAndEnterTelegram(cdp, origin+"?surface=customer-staging", signedProof(botToken, customerUserId), script, "customer");
    try {
      await poll("fresh client history HTTP 200 after Booking restart", () => responses.slice(historyResponseStart).some(r=>r.status===200&&r.path.endsWith("/staging-customer-history")));
    } catch (error) {
      const authResponses = responses.slice(historyResponseStart)
        .filter(r => r.path.includes("/auth/") || r.path.includes("/staging-customer"))
        .map(({ status, path }) => ({ status, path }));
      const screen = await evaluate(cdp, "document.body.innerText.slice(-800)");
      throw new Error(`${String(error)}; responses=${JSON.stringify(authResponses)}; screen=${JSON.stringify(screen)}`);
    }
    await requireDom(cdp, "own Booking survives restart with ID, status, price and times",
      "(()=>{const rows=[...document.querySelectorAll('[aria-label=\\\"Мои записи\\\"] .customer-history li')];const row=rows.find(r=>r.querySelector('.history-id')?.textContent.includes("+JSON.stringify(restartBookingId)+"));return rows.length===2&&row?.querySelector('.history-heading span')?.textContent==='Подтверждена'&&row.querySelectorAll('time')[0]?.dateTime==="+JSON.stringify(restartStart)+"&&row.querySelectorAll('time')[1]?.dateTime==="+JSON.stringify(restartEnd)+"&&row.innerText.replace(/\\s/g,'').includes('1250,50')&&rows.some(r=>r.querySelector('.history-id')?.textContent.includes("+JSON.stringify(realBooking.rows[0].id)+")&&r.querySelector('.history-heading span')?.textContent==='Отменена клиентом');})()");
    assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0);
    assert.deepEqual(await durableBooking(), beforeBookingRestart);
    const beforeFreshOwnerLogout = responses.length;
    await button(cdp, "Выйти");
    await poll("customer logout before fresh owner calendar: acknowledged", () => responses.slice(beforeFreshOwnerLogout).some(r =>
      ["/v1/auth/identity/logout", "/v1/auth/logout"].includes(r.path) && r.status===204));
    await requireDom(cdp, "customer logout before fresh owner calendar: protected data closed",
      "document.body.innerText.includes('Вы вышли') && !document.querySelector('[aria-label=\"Мои записи\"]') && !document.querySelector('[aria-label=\"Клиентская витрина staging\"]') && !document.body.innerText.includes('Вход клиента подтверждён')");
    script = await loadAndEnterTelegram(cdp, origin, signedProof(botToken, userId), script, "business");
    await requireDom(cdp, "fresh owner after Booking restart", "document.querySelector('.real-owner-nav')");
    await button(cdp, "Календарь");
    await requireDom(cdp, "owner calendar initialized after Booking restart",
      "document.querySelector('.owner-calendar select')?.options.length===2 && !document.querySelector('.owner-calendar select')?.disabled");
    await evaluate(cdp, "(()=>{const s=document.querySelector('.owner-calendar select');s.value="+JSON.stringify(locationId)+";s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await requireDom(cdp, "persisted branch selected after restart",
      "document.querySelector('.owner-calendar select')?.value==="+JSON.stringify(locationId)+" && !document.querySelector('.owner-calendar input[type=date]')?.disabled");
    const calendarResponseStart = responses.length;
    await fill(cdp, ".owner-calendar input[type=date]", date, "change");
    await poll("fresh owner calendar HTTP 200 after Booking restart", () => responses.slice(calendarResponseStart).some(r=>r.status===200&&r.path.endsWith("/owner-calendar")));
    await requireDom(cdp, "actual persisted Booking visible in owner's calendar after restart",
      "(()=>{const rows=[...document.querySelectorAll('[aria-label=\\\"Записи за выбранный период\\\"] .schedule-summary')];const fmt=value=>new Intl.DateTimeFormat('ru-RU',{timeZone:"+JSON.stringify(BRANCH_ZONE)+",dateStyle:'short',timeStyle:'short'}).format(new Date(value));const interval=fmt("+JSON.stringify(restartStart)+")+' — '+fmt("+JSON.stringify(restartEnd)+");const price=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(1250.5);return rows.length===3&&rows.filter(row=>row.innerText.includes(interval)&&row.innerText.includes(price)&&row.innerText.includes('Synthetic E2E Edited Service')&&row.innerText.includes('Synthetic E2E Staff')&&row.querySelector('.status-pill')?.innerText==='Подтверждена').length===1;})()");
    await verifyOwnerBookingDetail(cdp, responses, {
      bookingId: restartBookingId,
      duration: beforeBookingRestart.booking.service_duration_minutes_snapshot,
      buffer: beforeBookingRestart.booking.post_service_buffer_minutes_snapshot,
      priceKopecks: originalReceipt.priceKopecks,
      status: "Подтверждена", tenantId: owner.tenantId, viewport,
    });
    assert.deepEqual(await durableBooking(), beforeBookingRestart, "Fresh authenticated reads changed durable Booking/receipt/outbox");
    assert.deepEqual((await recoveryProjection()).rows, beforeProjection.rows);
    assert.equal(customerCreateRequests, writesBeforeRestart, "Restart recovery must not issue any Create POST");
    await button(cdp, "Выйти");
    await requireDom(cdp, "owner logout after Booking restart", "document.body.innerText.includes('Вы вышли') && !document.querySelector('.real-owner-nav')");
    assert.deepEqual(errors, [], "Unexpected browser runtime errors after Booking restart");
    assert.deepEqual(external, [], "Unexpected external requests after Booking restart");
    console.log("PASS actual UI-created Booking after compiled API restart: fresh client history and owner calendar, exact durable Booking/receipt/outbox, no repeated create.");

    // Preserve the direct cancellation test above. Independently lose the
    // second cancellation's actual committed response, then reconcile only
    // from a fresh server history read, without issuing another mutation.
    script = await loadAndEnterTelegram(cdp, origin+"?surface=customer-staging", signedProof(botToken, customerUserId), script, "customer");
    await requireDom(cdp, "fresh client before lost cancellation response", "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Отменить запись'&&!b.disabled)");
    let cancellationRequests = 0;
    cdp.onEvent("Network.requestWillBeSent", ({ request }) => {
      if (request.url.startsWith(origin) && request.method === "POST" && new URL(request.url).pathname.endsWith("/staging-customer-cancellation/"+restartBookingId)) cancellationRequests++;
    });
    await evaluate(cdp, "(()=>{const send=window.fetch.bind(window);window.fetch=async(input,init)=>{const response=await send(input,init);if(init?.method==='POST'&&String(input).endsWith("+JSON.stringify("/staging-customer-cancellation/"+restartBookingId)+")&&response.status===200){window.fetch=send;throw new Error('synthetic lost cancellation response');}return response;};})()");
    await button(cdp, "Отменить запись");
    await button(cdp, "Подтвердить отмену");
    await requireDom(cdp, "uncertain cancellation remains retryable", "document.body.innerText.includes('Результат отмены не подтверждён') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Повторить запрос отмены'&&!b.disabled)");
    const cancelledProjection = await durableBooking();
    assert.equal(cancelledProjection.booking.status, "CancelledByClient");
    assert.equal(cancelledProjection.tenant_count, beforeBookingRestart.tenant_count);
    assert.equal(cancelledProjection.receipts.length, 2);
    assert.equal(cancelledProjection.receipts.filter(r=>r.operation==="booking.cancel").length, 1);
    assert.equal(cancelledProjection.events.length, 2);
    assert.equal(cancelledProjection.events.filter(e=>e.topic==="booking.cancelled").length, 1);
    assert.equal(cancellationRequests, 1);
    const cancellationHistoryStart = responses.length;
    await button(cdp, "Обновить записи");
    await poll("fresh history HTTP 200 for cancellation reconciliation", () => responses.slice(cancellationHistoryStart).some(r=>r.status===200&&r.path.endsWith("/staging-customer-history")));
    await requireDom(cdp, "same cancelled booking resolves UI uncertainty without claiming receipt",
      "(()=>{const rows=[...document.querySelectorAll('[aria-label=\\\"Мои записи\\\"] .customer-history li')];const row=rows.find(r=>r.querySelector('.history-id')?.textContent.includes("+JSON.stringify(restartBookingId)+"));return row?.querySelector('.history-heading span')?.textContent==='Отменена клиентом'&&document.body.innerText.includes('В списке сервера запись отменена клиентом.')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Повторить запрос отмены');})()");
    assert.deepEqual(await durableBooking(), cancelledProjection);
    assert.equal(cancellationRequests, 1, "History reconciliation must not repeat cancellation POST");
    assert.equal(customerCreateRequests, writesBeforeRestart);
    const beforeCancellationReconciledLogout = responses.length;
    await button(cdp, "Выйти");
    await poll("client logout after cancellation reconciliation: acknowledged", () => responses.slice(beforeCancellationReconciledLogout).some(r =>
      ["/v1/auth/identity/logout", "/v1/auth/logout"].includes(r.path) && r.status===204));
    await requireDom(cdp, "client logout after cancellation reconciliation: protected data closed",
      "document.body.innerText.includes('Вы вышли') && !document.querySelector('[aria-label=\"Мои записи\"]') && !document.querySelector('[aria-label=\"Клиентская витрина staging\"]') && !document.body.innerText.includes('Вход клиента подтверждён')");
    console.log("PASS lost real cancellation response reconciled by own history without a repeat mutation.");

    script = await loadAndEnterTelegram(cdp, origin + "services", signedProof(botToken, userId), script, "business");
    await requireDom(cdp, "owner services warmed before revocation",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
    await button(cdp, "Мастера");
    await requireDom(cdp, "owner staff warmed before revocation",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    // An existing, synthetic Confirmed Booking is cancelled by the current
    // owner through the real compiled Calendar. Simulate a lost HTTP success:
    // the UI must never claim commit, and same-key retry has one side effect.
    await button(cdp,"Календарь");
    await requireDom(cdp,"owner edit calendar branch selector",
      "document.querySelector('.owner-calendar select')?.options.length===2");
    await evaluate(cdp,"(()=>{const s=document.querySelector('.owner-calendar select');s.value="+JSON.stringify(locationId)+";s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await fill(cdp,".owner-calendar input[type=date]",date,"change");
    const ownerEditScope=".owner-booking-detail[data-booking-id="+JSON.stringify(bookingId)+"]";
    const ownerEditRoot="document.querySelector("+JSON.stringify(ownerEditScope)+")";
    await requireDom(cdp,"owner edit target persisted record",
      ownerEditRoot+"?.querySelector('button[aria-expanded=false]')?.disabled===false");
    await evaluate(cdp,ownerEditRoot+".querySelector('button[aria-expanded=false]').click()");
    await requireDom(cdp,"owner cancel capability is verified",
      "(()=>{const root="+ownerEditRoot+";return !!root?.querySelector('dl')&&[...root.querySelectorAll('button')].some(b=>b.textContent.trim()==='Отменить запись'&&!b.disabled)})()");

    // #23: test the *real* owner Calendar time-only move before cancellation.
    // The same persisted Booking ID and immutable price are retained.
    await requireDom(cdp,"owner Calendar move capability verified",
      "(()=>{const root="+ownerEditRoot+";return [...root.querySelectorAll('button')].some(b=>b.textContent.trim()==='Перенести время'&&!b.disabled)})()");
    await evaluate(cdp,"(()=>{const root="+ownerEditRoot+";[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Перенести время').click();})()");
    const ownerMoveStart=date+"T07:00:00.000Z";
    await requireDom(cdp,"owner Calendar shows authoritative branch-zone move slots",
      "(()=>{const root="+ownerEditRoot+";return [...root.querySelectorAll('.owner-calendar-move option')].some(o=>o.value==="+JSON.stringify(ownerMoveStart)+")})()");
    await evaluate(cdp,"(()=>{const root="+ownerEditRoot+";const s=root.querySelector('.owner-calendar-move select');s.value="+JSON.stringify(ownerMoveStart)+";s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await evaluate(cdp,"(()=>{const root="+ownerEditRoot+";[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Проверить новое время').click();})()");
    await requireDom(cdp,"owner Calendar move requires explicit confirmation",
      ownerEditRoot+"?.innerText.includes('исходная стоимость сохранятся')&&[..."+ownerEditRoot+".querySelectorAll('button')].some(b=>b.textContent.trim()==='Подтвердить перенос'&&!b.disabled)");
    const ownerMoveUrl="/v1/organizations/"+owner.tenantId+"/owner-calendar/"+bookingId+"/reschedule";
    let ownerMoveRequests=0;
    cdp.onEvent("Network.requestWillBeSent",({request})=>{
      if(request.url.startsWith(origin)&&request.method==="POST"&&new URL(request.url).pathname===ownerMoveUrl)ownerMoveRequests++;
    });
    // Drop the first valid 200 *after the server committed*, capturing only
    // synthetic idempotency keys. The UI must not assume a successful write.
    await evaluate(cdp,"(()=>{const send=window.fetch.bind(window);let lost=false;window.__kukiOwnerMoveKeys=[];window.__kukiOwnerMoveBodies=[];window.__kukiOwnerMoveSynthetic=[];window.__kukiOwnerMoveNextStatus=null;window.fetch=async(input,init)=>{if(init?.method==='POST'&&String(input).split('?')[0].endsWith("+JSON.stringify(ownerMoveUrl)+")){window.__kukiOwnerMoveKeys.push(new Headers(init.headers).get('idempotency-key'));window.__kukiOwnerMoveBodies.push(init.body);const status=window.__kukiOwnerMoveNextStatus;if(status!==null){window.__kukiOwnerMoveNextStatus=null;window.__kukiOwnerMoveSynthetic.push(status);return Response.json({error:'synthetic rejected retry'},{status});}const reply=await send(input,init);if(!lost&&reply.status===200){lost=true;throw new Error('synthetic lost owner time-move receipt');}return reply;}return send(input,init);};})()");
    await evaluate(cdp,"(()=>{const root="+ownerEditRoot+";[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Подтвердить перенос').click();})()");
    await requireDom(cdp,"owner Calendar unknown move never shown as success",
      ownerEditRoot+"?.innerText.includes('Результат переноса неизвестен')&&[..."+ownerEditRoot+".querySelectorAll('button')].some(b=>b.textContent.trim()==='Повторить исходный перенос'&&!b.disabled)");
    assert.equal(ownerMoveRequests,1,"Unknown owner move must not auto-retry");

    const ownerMoved=await pool.query(
      "SELECT start_at,status,price_kopecks_snapshot::text AS price,staff_id::text AS staff,service_id::text AS service,location_id::text AS location FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [owner.tenantId,bookingId],
    );
    assert.equal(ownerMoved.rows[0].start_at.toISOString(),ownerMoveStart);
    assert.deepEqual(
      Object.fromEntries(["status","price","staff","service","location"].map(k=>[k,ownerMoved.rows[0][k]])),
      {status:"Confirmed",price:"125050",staff:beforeRestart.staffId,service:beforeRestart.serviceId,location:locationId},
    );
    const ownerMoveEffects=await pool.query(
      "SELECT (SELECT count(*)::int FROM cookie_booking.time_change_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.reschedule') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.rescheduled' AND payload->>'bookingId'=$2::text) AS events",
      [owner.tenantId,bookingId],
    );
    assert.deepEqual(ownerMoveEffects.rows[0],{audits:1,receipts:1,events:1});
    // A rejection of a retry is not proof that an earlier ambiguous commit failed.
    // Intercept the two responses before any network request; do not claim these
    // synthetic HTTP responses cover an actual concurrent authorization change.
    const clickOwnerMoveRetry="(()=>{const root="+ownerEditRoot+";[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Повторить исходный перенос').click();})()";
    for(const [index,status] of [409,404].entries()){
      await evaluate(cdp,"window.__kukiOwnerMoveNextStatus="+status);
      await evaluate(cdp,clickOwnerMoveRetry);
      await requireDom(cdp,"owner Calendar retains original uncertain move after synthetic "+status,
        "window.__kukiOwnerMoveSynthetic.length==="+(index+1)+"&&"+ownerEditRoot+"?.innerText.includes('Результат исходного переноса неизвестен')&&[..."+ownerEditRoot+".querySelectorAll('button')].some(b=>b.textContent.trim()==='Повторить исходный перенос'&&!b.disabled)&&!"+ownerEditRoot+".innerText.includes('Перенос не выполнен')");
      assert.equal(ownerMoveRequests,1,"Intercepted retry must not reach actual HTTP server");
      const attemptKeys=await evaluate(cdp,"window.__kukiOwnerMoveKeys");
      const attemptBodies=await evaluate(cdp,"window.__kukiOwnerMoveBodies");
      assert.equal(attemptKeys.length,index+2);
      assert.ok(attemptKeys.every(key=>key===attemptKeys[0]),"Every explicit retry must retain original key");
      assert.equal(attemptBodies.length,index+2);
      assert.ok(attemptBodies.every(body=>body===attemptBodies[0]),"Every retry must retain original time command");
      assert.deepEqual((await pool.query(
        "SELECT start_at,status,price_kopecks_snapshot::text AS price,staff_id::text AS staff,service_id::text AS service,location_id::text AS location FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [owner.tenantId,bookingId],
      )).rows,ownerMoved.rows,"Rejected retry must not alter committed booking");
      assert.deepEqual((await pool.query(
        "SELECT (SELECT count(*)::int FROM cookie_booking.time_change_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.reschedule') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.rescheduled' AND payload->>'bookingId'=$2::text) AS events",
        [owner.tenantId,bookingId],
      )).rows[0],ownerMoveEffects.rows[0],"Rejected retry must not duplicate business side effects");
    }
    assert.deepEqual(await evaluate(cdp,"window.__kukiOwnerMoveSynthetic"),[409,404]);
    await evaluate(cdp,clickOwnerMoveRetry);
    await requireDom(cdp,"owner Calendar refreshed only after acknowledged same-key move",
      "(()=>{const root="+ownerEditRoot+";return root?.querySelector('button[aria-expanded=false]')&&!root?.querySelector('.owner-calendar-move')})()");
    assert.equal(ownerMoveRequests,2,"Owner move must retry exactly once after explicit confirmation");
    const keys=await evaluate(cdp,"window.__kukiOwnerMoveKeys");
    assert.equal(keys.length,4,"Capture initial, two rejected and final real replay attempts");
    assert.equal(typeof keys[0],"string");
    assert.ok(keys[0].length>=16,"Expected a valid opaque idempotency key");
    assert.ok(keys.every(key=>key===keys[0]),"All owner retries must use the original idempotency key");
    const moveBodies=await evaluate(cdp,"window.__kukiOwnerMoveBodies");
    assert.equal(moveBodies.length,4);
    assert.ok(moveBodies.every(body=>body===moveBodies[0]),"All owner retries must keep the original time command");
    assert.deepEqual((await pool.query(
      "SELECT start_at,status,price_kopecks_snapshot::text AS price,staff_id::text AS staff,service_id::text AS service,location_id::text AS location FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [owner.tenantId,bookingId],
    )).rows,ownerMoved.rows,"Real replay must not alter committed booking");
    assert.deepEqual((await pool.query(
      "SELECT (SELECT count(*)::int FROM cookie_booking.time_change_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.reschedule') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.rescheduled' AND payload->>'bookingId'=$2::text) AS events",
      [owner.tenantId,bookingId],
    )).rows[0],ownerMoveEffects.rows[0],"Retry must not duplicate owner reschedule side effects");
    await evaluate(cdp,ownerEditRoot+".querySelector('button[aria-expanded=false]').click()");
    await requireDom(cdp,"owner Calendar cancellation still available after move",
      "(()=>{const root="+ownerEditRoot+";return [...root.querySelectorAll('button')].some(b=>b.textContent.trim()==='Отменить запись'&&!b.disabled)})()");
    console.log("PASS owner Calendar owner-only time move: lost real response, synthetic 409/404 retained uncertainty, explicit same-key recovery, unchanged price and booking scope, one audit/receipt/outbox.");
    await evaluate(cdp,"(()=>{const root="+ownerEditRoot+";[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Отменить запись').click();})()");
    await requireDom(cdp,"owner cancellation needs explicit second click",
      "(()=>{const root="+ownerEditRoot+";return root?.innerText.includes('Отменить подтверждённую запись для клиента?')&&[...root.querySelectorAll('button')].some(b=>b.textContent.trim()==='Подтвердить отмену'&&!b.disabled)})()");
    const ownerCancelUrl="/v1/organizations/"+owner.tenantId+"/owner-calendar/"+bookingId+"/cancel";
    let ownerCancellationRequests=0;
    cdp.onEvent("Network.requestWillBeSent",({request})=>{
      if(request.url.startsWith(origin)&&request.method==="POST"&&new URL(request.url).pathname===ownerCancelUrl)ownerCancellationRequests++;
    });
    await evaluate(cdp,"(()=>{const send=window.fetch.bind(window);let lost=false;window.__kukiOwnerCancelKeys=[];window.__kukiOwnerCancelBodies=[];window.__kukiOwnerCancelSynthetic=[];window.__kukiOwnerCancelNextStatus=null;window.fetch=async(input,init)=>{if(init?.method==='POST'&&String(input).split('?')[0].endsWith("+JSON.stringify(ownerCancelUrl)+")){window.__kukiOwnerCancelKeys.push(new Headers(init.headers).get('idempotency-key'));window.__kukiOwnerCancelBodies.push(init.body);const status=window.__kukiOwnerCancelNextStatus;if(status!==null){window.__kukiOwnerCancelNextStatus=null;window.__kukiOwnerCancelSynthetic.push(status);return Response.json({error:'synthetic rejected cancellation retry'},{status});}const reply=await send(input,init);if(!lost&&reply.status===200){lost=true;throw new Error('synthetic lost owner cancellation response');}return reply;}return send(input,init);};})()");
    await evaluate(cdp,"(()=>{const root="+ownerEditRoot+";[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Подтвердить отмену').click();})()");
    await requireDom(cdp,"owner unknown commit is not shown as success",
      ownerEditRoot+"?.innerText.includes('Результат отмены неизвестен')&&[..."+ownerEditRoot+".querySelectorAll('button')].some(b=>b.textContent.trim()==='Повторить исходную отмену'&&!b.disabled)");
    const ownerCommitted=await pool.query(
      "SELECT status,price_kopecks_snapshot::text AS price FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [owner.tenantId,bookingId],
    );
    assert.deepEqual(ownerCommitted.rows,[{status:"CancelledByBusiness",price:"125050"}]);
    assert.equal(ownerCancellationRequests,1,"Unknown owner result may not spontaneously retry");
    const cancellationEffects=async()=> (await pool.query(
      "SELECT (SELECT count(*)::int FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.cancel') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.cancelled' AND payload->>'bookingId'=$2::text) AS events",
      [owner.tenantId,bookingId],
    )).rows[0];
    assert.deepEqual(await cancellationEffects(),{audits:1,receipts:1,events:1});
    const clickCancellationRetry="(()=>{const root="+ownerEditRoot+";[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Повторить исходную отмену').click();})()";
    // Rejections below are injected before the network. They test mounted
    // uncertainty handling, not a real authorization revocation. A 401/403
    // tears down the protected owner shell via createOwnerReads; never keep
    // that shell mounted for the sake of an ambiguous receipt.
    for(const [index,status] of [409,404,503].entries()){
      await evaluate(cdp,"window.__kukiOwnerCancelNextStatus="+status);
      await evaluate(cdp,clickCancellationRetry);
      await requireDom(cdp,"owner cancellation remains unknown after synthetic "+status,
        "window.__kukiOwnerCancelSynthetic.length==="+(index+1)+"&&"+ownerEditRoot+"?.innerText.includes('Результат исходной отмены неизвестен')&&[..."+ownerEditRoot+".querySelectorAll('button')].some(b=>b.textContent.trim()==='Повторить исходную отмену'&&!b.disabled)&&!"+ownerEditRoot+".innerText.includes('Отмена не выполнена')");
      assert.equal(ownerCancellationRequests,1,"Synthetic rejection must not reach the server");
      const attemptKeys=await evaluate(cdp,"window.__kukiOwnerCancelKeys");
      const attemptBodies=await evaluate(cdp,"window.__kukiOwnerCancelBodies");
      assert.equal(attemptKeys.length,index+2);
      assert.ok(attemptKeys.every(key=>key===attemptKeys[0]),"Rejected retry must keep original key");
      assert.equal(attemptBodies.length,index+2);
      assert.ok(attemptBodies.every(body=>body===attemptBodies[0]),"Rejected retry must keep original command");
      assert.deepEqual((await pool.query(
        "SELECT status,price_kopecks_snapshot::text AS price FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [owner.tenantId,bookingId],
      )).rows,ownerCommitted.rows);
      assert.deepEqual(await cancellationEffects(),{audits:1,receipts:1,events:1});
    }
    assert.deepEqual(await evaluate(cdp,"window.__kukiOwnerCancelSynthetic"),[409,404,503]);
    await evaluate(cdp,clickCancellationRetry);
    await requireDom(cdp,"owner calendar refreshed after acknowledged same-key receipt",
      "(()=>{const rows=[...document.querySelectorAll('[aria-label=\"Записи за выбранный период\"] .schedule-summary')];return rows.some(r=>r.querySelector('.owner-booking-detail[data-booking-id="+JSON.stringify(bookingId)+"]')&&r.querySelector('.status-pill')?.textContent==='Отменена салоном')})()");
    const ownerEffects=await pool.query(
      "SELECT (SELECT count(*)::int FROM cookie_booking.booking_state_audit WHERE tenant_id=$1::uuid AND booking_id=$2::uuid) AS audits,(SELECT count(*)::int FROM cookie_booking.command_receipts WHERE tenant_id=$1::uuid AND booking_id=$2::uuid AND operation='booking.cancel') AS receipts,(SELECT count(*)::int FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND topic='booking.cancelled' AND payload->>'bookingId'=$2::text) AS events",
      [owner.tenantId,bookingId],
    );
    assert.deepEqual(ownerEffects.rows[0],{audits:1,receipts:1,events:1});
    assert.equal(ownerCancellationRequests,2,"Only the original and final replay may reach the server");
    const cancellationKeys=await evaluate(cdp,"window.__kukiOwnerCancelKeys");
    const cancellationBodies=await evaluate(cdp,"window.__kukiOwnerCancelBodies");
    assert.equal(cancellationKeys.length,5);
    assert.equal(typeof cancellationKeys[0],"string");
    assert.ok(cancellationKeys[0].length>=16);
    assert.ok(cancellationKeys.every(key=>key===cancellationKeys[0]),"All cancellation attempts must keep the original key");
    assert.equal(cancellationBodies.length,5);
    assert.ok(cancellationBodies.every(body=>body===cancellationBodies[0]),"All cancellation attempts must keep the original payload");
    assert.deepEqual((await pool.query(
      "SELECT status,price_kopecks_snapshot::text AS price FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [owner.tenantId,bookingId],
    )).rows,ownerCommitted.rows);
    for(const [width,height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"owner calendar after cancel "+width+"px");
      await checkLabeledControls(cdp,"owner calendar after cancel "+width+"px");
    }
    console.log("PASS owner Calendar real browser cancellation: lost 200, synthetic 409/404/503 remain unknown, real same-key replay, immutable price and one audit/receipt/outbox.");

    const revokedOwner = await pool.query(
      "UPDATE cookie_identity.opaque_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND revoked_at IS NULL",
      [owner.tenantId],
    );
    assert.ok(revokedOwner.rowCount > 0, "Expected an active synthetic owner session");
    const denialMarker = responses.length;
    await button(cdp, "Услуги");
    await poll("fresh owner request denied after revocation", () =>
      responses.slice(denialMarker).some(r => r.path.endsWith("/services") && (r.status === 401 || r.status === 403)),
    );
    await requireDom(cdp, "owner denial clears the exact protected workspace",
      "document.body.innerText.includes('Доступ к кабинету не подтверждён сервером') && !document.querySelector('.real-owner-nav') && !document.body.innerText.includes('Synthetic E2E Edited Service') && !document.body.innerText.includes('Synthetic E2E Staff')");
    assert.deepEqual(errors, [], "Unexpected browser runtime errors after owner revocation");
    assert.deepEqual(external, [], "Unexpected external requests after owner revocation");

    assert.deepEqual(errors, [], "Unexpected browser runtime errors during booking");
    assert.deepEqual(external, [], "Unexpected external requests during booking");
    // Migrate the same synthetic customer only after actual UI booking,
    // cancellation and receipt recovery. No runtime migration route exists.
    const legacyCustomer = await pool.query(
      `SELECT c.customer_id::text,c.identity_id::text,c.telegram_link_id::text
       FROM cookie_customers.staging_customer_identities c WHERE c.tenant_id=$1::uuid`,
      [owner.tenantId],
    );
    assert.equal(legacyCustomer.rowCount,1);
    const original = legacyCustomer.rows[0];
    const ownedBookings = () => pool.query(
      "SELECT id::text,customer_id::text,status FROM cookie_booking.bookings WHERE tenant_id=$1::uuid AND customer_id=$2::uuid ORDER BY id",
      [owner.tenantId,original.customer_id],
    );
    const beforeMigration = await ownedBookings();
    assert.equal(beforeMigration.rowCount,2);
    const migrationVerifier = createTelegramMiniAppProofVerifier({botToken,maxAgeSeconds:300});
    const migrationTransaction = (work) => runSqlTransaction(pool,work);
    const migrationRequest = randomUUID();
    assert.equal(await prepareLegacyTelegramMigration(migrationTransaction,migrationVerifier,userHashSecret,{
      requestId:migrationRequest,tenantId:owner.tenantId,
      identityId:original.identity_id,legacyLinkId:original.telegram_link_id,
      rawInitData:signedProof(botToken,customerUserId),consentConfirmed:true,
    }),"prepared");
    assert.equal(await activateLegacyTelegramMigration(migrationTransaction,migrationVerifier,userHashSecret,{
      requestId:migrationRequest,rawInitData:signedProof(botToken,customerUserId),consentConfirmed:true,
    }),"activated");
    // Re-enter with a new signed proof after activation revoked the old bearer.
    const beforeMigratedLogin = responses.length;
    script=await loadAndEnterTelegram(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script,"customer");
    await requireDom(cdp,"migrated client has existing organization",
      "document.querySelector('[aria-label=\"Клиентские организации\"] button') && !document.querySelector('[aria-label=\"Клиентская витрина staging\"]')");
    await evaluate(cdp,"document.querySelector('[aria-label=\"Клиентские организации\"] button').click()");
    await requireDom(cdp,"migrated client sees both original bookings",
      "document.querySelector("+JSON.stringify(historyPanel)+")?.innerText.includes("+JSON.stringify(beforeRecovery.rows[0].id)+") && document.querySelector("+JSON.stringify(historyPanel)+")?.innerText.includes("+JSON.stringify(realBooking.rows[0].id)+")");
    assert.ok(responses.slice(beforeMigratedLogin).some(r=>r.path==="/v1/auth/browser-session"&&r.status===204));
    const migrationReload = responses.length;
    await cdp.send("Page.reload",{ignoreCache:true});
    await poll("migrated browser cookie restored",()=>responses.slice(migrationReload).some(r=>r.path==="/v1/auth/browser-session"&&r.status===200));
    await requireDom(cdp,"migrated booking history restored without proof replay",historyContains+" && document.querySelector("+JSON.stringify(historyPanel)+")?.innerText.includes("+JSON.stringify(beforeRecovery.rows[0].id)+")");
    assert.equal(responses.slice(migrationReload).filter(r=>r.path==="/v1/auth/telegram/identity").length,0);
    assert.equal(responses.slice(beforeMigratedLogin).filter(r=>r.path.endsWith("/staging-customer/enroll")).length,0);
    assert.deepEqual((await pool.query(
      "SELECT customer_id::text,identity_id::text,telegram_link_id::text FROM cookie_customers.staging_customer_identities WHERE tenant_id=$1::uuid",
      [owner.tenantId],
    )).rows,legacyCustomer.rows);
    assert.deepEqual((await ownedBookings()).rows,beforeMigration.rows);
    assert.deepEqual((await recoveryProjection()).rows,beforeProjection.rows);
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    // Original trusted-link revocation must invalidate the migrated cookie,
    // close the private UI and leave booking data intact.
    assert.equal((await pool.query(
      "UPDATE cookie_identity.telegram_identity_links SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid AND revoked_at IS NULL",
      [owner.tenantId,original.telegram_link_id],
    )).rowCount,1);
    const beforeMigrationRevoke=responses.length;
    await cdp.send("Page.reload",{ignoreCache:true});
    await poll("revoked migration cookie rejected",()=>responses.slice(beforeMigrationRevoke).some(r=>r.path==="/v1/auth/browser-session"&&r.status===401));
    await requireDom(cdp,"revoked migrated session hides history",
      "!document.querySelector("+JSON.stringify(historyPanel)+") && !document.querySelector("+JSON.stringify(panel)+") && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Войти через Telegram')");
    assert.deepEqual((await ownedBookings()).rows,beforeMigration.rows);
    assert.deepEqual(errors, [], "Unexpected browser runtime errors after migration");
    assert.deepEqual(external, [], "Unexpected external requests after migration");
    console.log("PASS synthetic migrated customer retains original Identity, booking history, cookie restoration and source revocation");
    const demoApiRequests = [];
    cdp.onEvent("Network.requestWillBeSent", ({ request }) => {
      if (request.url.startsWith(origin + "v1/")) demoApiRequests.push(new URL(request.url).pathname);
    });
    for (const path of ["demo", "demo/", "demo?browser-smoke=1", "demo/example"]) {
      const result = await getLocal(origin + path);
      assert.equal(result.status, 404, "Legacy fixture exposed by compiled API: " + path);
      assert.doesNotMatch(result.text, /<html/i);
    }
    script = await load(cdp, origin + "demo", signedProof(botToken, userId), script);
    await requireDom(cdp, "legacy route no longer serves an application",
      "location.pathname==='/demo' && document.readyState==='complete' && !document.querySelector('[data-cookie-mode]')");
    assert.deepEqual(demoApiRequests, [], "Retired demo route called real API");
    assert.deepEqual(external, [], "Retired demo route made external requests");
    // #222: an unpublished salon URL must be a separate, unprivileged shell.
    // A valid or stale browser session must not turn it into an owner login.
    const unavailableApiRequests = [];
    cdp.onEvent("Network.requestWillBeSent", ({ request }) => {
      if (request.url.startsWith(origin + "v1/")) {
        unavailableApiRequests.push(new URL(request.url).pathname);
      }
    });
    for (const path of ["book", "book/unknown-synthetic-salon"]) {
      const response = await getLocal(origin + path);
      assert.equal(response.status, 404, "Unpublished booking path must return HTTP 404: " + path);
      await cdp.send("Page.navigate", { url: origin + path });
      await requireDom(cdp, "unpublished booking path " + path,
        "document.querySelector('[data-kuki-public-booking=unavailable]') && " +
        "document.body.innerText.includes('Публичная запись ещё не подключена') && " +
        "!document.querySelector('.real-owner-nav, form')");
      await cdp.send("Page.reload", { ignoreCache: true });
      await requireDom(cdp, "unpublished booking reload " + path,
        "document.querySelector('[data-kuki-public-booking=unavailable]') && " +
        "!document.querySelector('.real-owner-nav, form')");
    }
    assert.deepEqual(unavailableApiRequests, [], "Unpublished salon URL triggered authenticated API");
    console.log("PASS integrated real owner/customer browser: direct owner routes and history navigation, fresh protected reads and fail-closed revocation, Overview + Location + Service create/edit + Staff + ShiftPlan, staging activation/publication, real client catalog and opt-in Booking, PostgreSQL restart persistence, logout and 4 viewports.");
  } finally {
    if (cdp) cdp.close();
    try {
      await stopBrowser(chrome);
      if (browserData) rmSync(browserData, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } finally {
      try { await stopServer(api); } finally { await pool.end(); }
    }
  }
}

// Avoid printing network bodies, env, tokens or browser DOM after failures.
main().catch((error) => {
  console.error("Real owner browser smoke failed: " + error.message);
  process.exitCode = 1;
});
