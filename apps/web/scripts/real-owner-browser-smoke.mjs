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

async function waitForm(cdp, name) {
  await requireDom(cdp, name, "document.querySelector('.owner-form input') && document.querySelector('h1')");
}

async function assertStored(pool, owner, locationId) {
  const result = await pool.query(
    `SELECT
       s.id::text AS service_id, s.display_name AS service_name,
       s.duration_minutes, s.base_price_kopecks::text AS price, s.active AS service_active, s.draft_revision,
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
    "document.querySelector('h1')?.textContent.trim()==='Synthetic browser salon' && " +
    "document.querySelector('.list-items')?.innerText.includes('Synthetic Central') && " +
    "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(BRANCH_NAME) + ") && " +
    "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(BRANCH_ZONE) + ")");
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
      COOKIE_STAGING_PUBLICATION_MODE: "enabled",
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

    // Malformed proof must not show authenticated UI or a synthetic fallback.
    let script = await load(cdp, origin, "invalid-synthetic-proof", undefined);
    await requireDom(cdp, "forged proof rejected",
      "document.body.innerText.includes('Вход не подтверждён') && !document.querySelector('.real-owner-nav')");
    assert.ok(responses.some((r) => r.path === "/v1/auth/telegram/exchange" && r.status === 401));
    script = await load(cdp, origin, signedProof(botToken, userId), script);
    await requireDom(cdp, "authenticated real services",
      "document.querySelector('.real-owner-nav') && document.body.innerText.includes('Услуги салона')");
    await requireDom(cdp, "shared owner shell without demo controls", "document.querySelector(\'.verified-owner-shell[data-cookie-mode=api] .sidebar\') && !document.querySelector(\'.demo-ribbon, .preview-control, .onboarding-header\')");
    await requireDom(cdp, "canonical runtime owner brand", "document.querySelector('.sidebar .brand strong')?.textContent.trim() === 'kuki.' && document.querySelector('.nav-links')?.getAttribute('aria-label') === 'Разделы kuki' && document.title === 'kuki — кабинет салона'");
    await button(cdp, "Оформление");
    await requireDom(cdp, "real appearance draft loaded", "document.querySelector('.brand-editor') && document.body.innerText.includes('Только черновик') && document.querySelector('.brand-presets button')");
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
    await button(cdp, "Онлайн-запись");
    await requireDom(cdp, "owner booking unavailable without customer identity", "document.querySelector('h1')?.textContent==='Онлайн-запись' && document.body.innerText.includes('Клиентская запись — отдельный вход') && !document.querySelector('.booking-form')");
    await button(cdp, "Услуги");
    await waitForm(cdp, "real service form");
    await checkWidth(cdp, "real services 375px");
    await checkLabeledControls(cdp, "real service form");
    await fill(cdp, ".owner-form input:not([type=number])", "Synthetic E2E Service");
    await fill(cdp, ".owner-form input[type=number]:nth-of-type(1)", "45");
    // The two numeric fields belong to separate labels.
    await evaluate(cdp, "(() => {const n=document.querySelectorAll('.owner-form input[type=number]');n[0].value='45';n[0].dispatchEvent(new Event('input',{bubbles:true}));n[1].value='1200';n[1].dispatchEvent(new Event('input',{bubbles:true}));})()");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "persisted service renders",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Service') && !document.querySelector('.owner-form button[type=submit]')?.disabled");
    await button(cdp, "Филиалы");
    await requireDom(cdp, "real locations loaded",
      "document.querySelector('h1')?.textContent.trim()==='Филиалы' && document.querySelector('.list-items')?.innerText.includes('Synthetic Central') && document.querySelector('.owner-form input')");
    await checkWidth(cdp, "real locations 375px");
    await checkLabeledControls(cdp, "real locations form");
    await fill(cdp, ".owner-form input[placeholder='Студия на Невском']", BRANCH_NAME);
    await fill(cdp, ".owner-form input[placeholder='Europe/Moscow']", BRANCH_ZONE);
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "browser-created branch saved",
      "document.querySelector('.list-items')?.innerText.includes(" + JSON.stringify(BRANCH_NAME) + ") && !document.querySelector('.owner-form button[type=submit]')?.disabled");
    const locationId = await assertBranch(pool, owner);
    await requireOverview(cdp);
    await checkWidth(cdp, "real overview 375px");

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
    await button(cdp, "Услуги");
    await requireDom(cdp, "service edit button", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Service')");
    await button(cdp, "Изменить");
    await requireDom(cdp, "edit selected", "document.querySelector('.owner-form')?.innerText.includes('Сохранить изменения')");
    await evaluate(cdp, "(() => {const inputs=document.querySelectorAll('.owner-form input');const values=['Synthetic E2E Edited Service','50','1250.50'];inputs.forEach((input,i)=>{input.value=values[i];input.dispatchEvent(new Event('input',{bubbles:true}));});})()");
    await submitValidForm(cdp, ".owner-form");
    await requireDom(cdp, "edited service visible", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service') && document.querySelector('.list-items')?.innerText.includes('50 мин')");
    await checkWidth(cdp, "edited list 375px");
    await button(cdp, "Мастера");
    await requireDom(cdp, "assignment retains edited service", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
    const beforeRestart = await assertStored(pool, owner, locationId);
    assert.ok(responses.some((r) => r.status === 200 && r.path.endsWith('/services/' + beforeRestart.serviceId)));
    await button(cdp, "Расписание");
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
    script = await load(cdp, origin, signedProof(botToken, userId), script);
    await requireDom(cdp, "service persisted after process restart",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
    await button(cdp, "Мастера");
    await requireDom(cdp, "staff persisted after process restart",
      "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    await requireOverview(cdp);
    await requireShift(cdp);
    assert.equal(await assertBranch(pool, owner), locationId);
    assert.equal(await assertPlan(pool, owner, beforeRestart.staffId, locationId, date), shiftId);
    await button(cdp, "Мастера");
    await requireDom(cdp, "staff after restart", "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    for (const [width, height] of [[320, 568], [1280, 800]]) {
      await viewport(cdp, width, height);
      await checkWidth(cdp, "real staff " + width + "px");
      await checkLabeledControls(cdp, "real staff " + width + "px");
      await button(cdp, "Услуги");
      await requireDom(cdp, "service list at " + width, "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
      await checkWidth(cdp, "real services " + width + "px");
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
    await button(cdp, "Подготовить публикацию");
    await requireDom(cdp, "confirmation before active shift", "document.querySelector('[aria-label=\"Подтверждение публикации смены\"]')");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid AND active",[owner.tenantId])).rows[0].count,0);
    await button(cdp, "Подтвердить публикацию");
    await requireDom(cdp, "published shift read after commit", "document.querySelector('.schedule-summary')?.innerText.includes('Опубликована в тестовом контуре')");
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
    script = await load(cdp, origin, signedProof(botToken, userId), script);
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
    script=await load(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script);
    await requireDom(cdp,"verified client context","document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.innerText==='Вход клиента подтверждён' && !document.querySelector('.real-owner-nav')");
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-context")));
    await checkWidth(cdp,"real client context");
    const panel='[aria-label="Клиентская витрина staging"]';
    await requireDom(cdp,"published client catalog","document.querySelector("+JSON.stringify(panel+" select")+")?.options.length===2");
    for(let i=0;i<3;i++){
      await requireDom(cdp,"available selection "+i,"document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"]?.options.length===2 && !document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"]?.disabled");
      await evaluate(cdp,"(()=>{const s=document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"];s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    }
    await requireDom(cdp,"client date enabled","!document.querySelector("+JSON.stringify(panel+" input[type=date]")+")?.disabled");
    await evaluate(cdp,"(()=>{const d=document.querySelector("+JSON.stringify(panel+" input[type=date]")+");d.value="+JSON.stringify(date)+";d.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await button(cdp,"Найти свободное время");
    await requireDom(cdp,"real customer slots","document.querySelectorAll("+JSON.stringify(panel+" .customer-slot-choice")+")?.length===29");
    await evaluate(cdp,"document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+").click()");
    await requireDom(cdp,"slot is not reserved","document.querySelector("+JSON.stringify(panel+" .customer-choice-summary")+")?.innerText.includes('Время не забронировано')");
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-offers")));
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/staging-customer-slots")));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM cookie_booking.bookings WHERE tenant_id=$1::uuid",[owner.tenantId])).rows[0].count,0);
    await checkWidth(cdp,"real customer offers");
    await checkLabeledControls(cdp,"real customer offers");
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0);
    await button(cdp,"Выйти");
    await requireDom(cdp,"customer logout","document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.innerText==='Вы вышли'");
    script=await load(cdp,origin+"?surface=customer-staging",signedProof(botToken,userId),script);
    await requireDom(cdp,"owner rejected on client surface","document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.innerText==='Вход клиента не подтверждён'");
    assert.ok(!(await evaluate(cdp,"Boolean(document.querySelector('.real-owner-nav'))")));
    assert.deepEqual(external, [], "Unexpected real-mode external network requests");
    assert.deepEqual(errors, [], "Unexpected browser runtime errors");
    // Main's suspended-tab expiry contract also applies to the client surface.
    script=await load(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script);
    await requireDom(cdp,"client catalog before local expiry","document.querySelector("+JSON.stringify(panel+" select")+")?.options.length===2");
    await evaluate(cdp,"window.__cookieTestClockMs=3600001;document.dispatchEvent(new Event('visibilitychange'));");
    await requireDom(cdp,"client fails closed on local expiry","!document.querySelector("+JSON.stringify(panel)+") && document.querySelector('[aria-label=\"Клиентский вход staging\"] h1')?.innerText==='Вход клиента не подтверждён'");
    script=await load(cdp,origin,signedProof(botToken,userId),script);
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
    await button(cdp,"Неделя");
    await requireDom(cdp,"week reads persisted Booking","document.querySelector('[aria-label=\"Записи за выбранный период\"]')?.innerText.includes('Synthetic E2E Staff')");
    assert.ok(responses.some(r=>r.status===200&&r.path.endsWith("/owner-calendar")));
    await verifyOwnerBookingDetail(cdp, responses, {
      bookingId, duration: 50, buffer: 0, priceKopecks: "125050",
      status: "Подтверждена", tenantId: owner.tenantId, viewport,
    });
    for(const [width,height] of [[320,568],[375,812],[1280,800]]) {
      await viewport(cdp,width,height);
      await checkWidth(cdp,"real owner calendar "+width+"px");
      await checkLabeledControls(cdp,"real owner calendar "+width+"px");
    }


    await button(cdp, "Выйти");
    await requireDom(cdp, "calendar owner logout", "document.body.innerText.includes('Вы вышли')");
    // Launch a fresh verified session, then simulate tab resume after local expiry.
    script = await load(cdp, origin, signedProof(botToken, userId), script);
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
    api = await startServer({ ...env, COOKIE_STAGING_CUSTOMER_BOOKING_MODE: "enabled", COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES: "60" }, origin);
    script = await load(cdp, origin+"?surface=customer-staging", signedProof(botToken,customerUserId), script);
    await requireDom(cdp,"write-enabled customer catalog","document.querySelector("+JSON.stringify(panel+" select")+")?.options.length===2");
    for(let i=0;i<3;i++){
      await requireDom(cdp,"booking selection "+i,"document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"]?.options.length===2 && !document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"]?.disabled");
      await evaluate(cdp,"(()=>{const s=document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"];s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    }
    await fill(cdp,panel+" input[type=date]",date,"change");
    await button(cdp,"Найти свободное время");
    await requireDom(cdp,"slots before actual booking","document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+")");
    await evaluate(cdp,"document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+").click()");
    await requireDom(cdp,"real write button","Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Записаться'&&!b.disabled)");
    await button(cdp,"Записаться");
    await requireDom(cdp,"server-confirmed real booking","document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Создание записи подтверждено') && document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Фактическая стоимость')");
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
      "document.querySelector("+JSON.stringify(panel+" select")+")?.options.length===2 && !"+receiptCard);
    assert.equal(await evaluate(cdp,"localStorage.length + sessionStorage.length"),0,"Cancellation must not create a pending Create marker");
    for(let i=0;i<3;i++){
      await requireDom(cdp,"recovery selection "+i,"document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"]?.options.length===2 && !document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"]?.disabled");
      await evaluate(cdp,"(()=>{const s=document.querySelectorAll("+JSON.stringify(panel+" select")+")["+i+"];s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    }
    await fill(cdp,panel+" input[type=date]",date,"change");
    await button(cdp,"Найти свободное время");
    await requireDom(cdp,"slots before lost response","document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+")");
    await evaluate(cdp,"document.querySelector("+JSON.stringify(panel+" .customer-slot-choice")+").click()");
    await requireDom(cdp,"second write available","Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Записаться'&&!b.disabled)");
    // Drop the real response only after the server has returned 201.
    await evaluate(cdp,"(()=>{const send=window.fetch.bind(window);window.fetch=async(input,init)=>{const response=await send(input,init);if(init?.method==='POST'&&String(input).endsWith('/staging-customer-bookings')&&response.status===201)throw new Error('synthetic lost response');return response;};})()");
    await button(cdp,"Записаться");
    await requireDom(cdp,"uncertain actual committed result","document.querySelector("+JSON.stringify(panel)+")?.innerText.includes('Статус записи не подтверждён')");
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
    script=await load(cdp,origin+"?surface=customer-staging",signedProof(botToken,customerUserId),script);
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
    await button(cdp, "Выйти");
    await requireDom(cdp, "customer logout before Booking restart",
      "document.querySelector('[aria-label=\\\"Клиентский вход staging\\\"] h1')?.innerText==='Вы вышли' && !document.querySelector('[aria-label=\\\"Мои записи\\\"]')");
    await stopServer(api);
    api = await startServer({ ...env, COOKIE_STAGING_CUSTOMER_BOOKING_MODE: "enabled", COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES: "60" }, origin);

    const historyResponseStart = responses.length;
    script = await load(cdp, origin+"?surface=customer-staging", signedProof(botToken, customerUserId), script);
    await poll("fresh client history HTTP 200 after Booking restart", () => responses.slice(historyResponseStart).some(r=>r.status===200&&r.path.endsWith("/staging-customer-history")));
    await requireDom(cdp, "own Booking survives restart with ID, status, price and times",
      "(()=>{const rows=[...document.querySelectorAll('[aria-label=\\\"Мои записи\\\"] .customer-history li')];const row=rows.find(r=>r.querySelector('.history-id')?.textContent.includes("+JSON.stringify(restartBookingId)+"));return rows.length===2&&row?.querySelector('.history-heading span')?.textContent==='Подтверждена'&&row.querySelectorAll('time')[0]?.dateTime==="+JSON.stringify(restartStart)+"&&row.querySelectorAll('time')[1]?.dateTime==="+JSON.stringify(restartEnd)+"&&row.innerText.replace(/\\s/g,'').includes('1250,50')&&rows.some(r=>r.querySelector('.history-id')?.textContent.includes("+JSON.stringify(realBooking.rows[0].id)+")&&r.querySelector('.history-heading span')?.textContent==='Отменена клиентом');})()");
    assert.equal(await evaluate(cdp, "localStorage.length + sessionStorage.length"), 0);
    assert.deepEqual(await durableBooking(), beforeBookingRestart);
    await button(cdp, "Выйти");
    await requireDom(cdp, "customer logout before fresh owner calendar",
      "document.querySelector('[aria-label=\\\"Клиентский вход staging\\\"] h1')?.innerText==='Вы вышли'");
    script = await load(cdp, origin, signedProof(botToken, userId), script);
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
    script = await load(cdp, origin+"?surface=customer-staging", signedProof(botToken, customerUserId), script);
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
    await button(cdp, "Выйти");
    await requireDom(cdp, "client logout after cancellation reconciliation", "document.querySelector('[aria-label=\\\"Клиентский вход staging\\\"] h1')?.innerText==='Вы вышли'");
    console.log("PASS lost real cancellation response reconciled by own history without a repeat mutation.");


    assert.deepEqual(errors, [], "Unexpected browser runtime errors during booking");
    assert.deepEqual(external, [], "Unexpected external requests during booking");
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
    console.log("PASS integrated real owner/customer browser: main Overview + Location + Service create/edit + Staff + same ShiftPlan, staging activation/publication, server slot preview, real client catalog, default-off preview, opt-in actual Booking creation and own cancellation, seeded read-only owner Calendar, PostgreSQL restart persistence, owner/client local expiry and logout, 3 viewports.");
  } finally {
    if (cdp) cdp.close();
    try {
      await stopBrowser(chrome);
      if (browserData) rmSync(browserData, { recursive: true, force: true });
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
