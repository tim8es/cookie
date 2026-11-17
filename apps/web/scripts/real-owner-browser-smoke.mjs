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

import { runMigrations } from "../../../dist/packages/platform-db/src/migrations.js";
import { provisionOwnerWorkspace } from "../../../dist/packages/platform-identity/src/provision-owner-workspace.js";
import { issueStagingGrant } from "../../../dist/packages/domain-entitlement/src/staging.js";
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

async function button(cdp, label) {
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
    source: "window.Telegram={WebApp:{initData:" + JSON.stringify(proof) + "}};",
  });
  await cdp.send("Page.navigate", { url: origin });
  return identifier;
}

async function waitForm(cdp, name) {
  await requireDom(cdp, name, "document.querySelector('.owner-form input') && document.querySelector('h1')");
}

async function assertStored(pool, owner) {
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
  assert.equal(row.location_id, owner.locationId);
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

async function main() {
  const databaseUrl = isolatedDatabase();
  const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: "cookie-real-owner-browser-ci" });
  const botToken = "123456789:" + randomBytes(24).toString("base64url");
  const userHashSecret = randomBytes(32);
  const userId = randomInt(100000000, 999999999);
  const browserData = mkdtempSync(join(tmpdir(), "cookie-real-owner-"));
  let api, chrome, cdp;
  const errors = [], external = [], responses = [];
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
    const chromePort = await freePort();
    chrome = spawn(browserBinary(), [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-networking", "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=" + chromePort,
      "--user-data-dir=" + browserData,
      "about:blank",
    ], { stdio: "ignore" });
    const target = await poll("browser target", async () => {
      const response = await getLocal("http://127.0.0.1:" + chromePort + "/json/list");
      return JSON.parse(response.text).find((page) => page.type === "page" && page.webSocketDebuggerUrl);
    }, 20000);
    cdp = createClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["https://*"] });
    cdp.onEvent("Runtime.exceptionThrown", () => errors.push("uncaught page exception"));
    cdp.onEvent("Network.requestWillBeSent", ({ request }) => {
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
    await button(cdp, "Мастера");
    await requireDom(cdp, "real staff page", "document.querySelector('h1')?.textContent.trim()==='Мастера'");
    await requireDom(cdp, "real staff form", "document.querySelectorAll('.owner-form select').length===2");
    await checkWidth(cdp, "real staff 375px");
    await checkLabeledControls(cdp, "real staff form");
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
    const beforeRestart = await assertStored(pool, owner);
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
    for (const [width, height] of [[320, 568], [1280, 800]]) {
      await viewport(cdp, width, height);
      await checkWidth(cdp, "real staff " + width + "px");
      await checkLabeledControls(cdp, "real staff " + width + "px");
      await button(cdp, "Услуги");
      await requireDom(cdp, "service list at " + width, "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Edited Service')");
      await checkWidth(cdp, "real services " + width + "px");
      await button(cdp, "Мастера");
      await requireDom(cdp, "staff list at " + width, "document.querySelector('.list-items')?.innerText.includes('Synthetic E2E Staff')");
    }
    assert.deepEqual(await assertStored(pool, owner), beforeRestart, "Restart changed persisted IDs");
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
    await viewport(cdp, 375, 812);
    await button(cdp, "Расписание");
    await requireDom(cdp,"real schedule form","document.querySelectorAll('.owner-form input[type=datetime-local]').length===2");
    const date=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    await evaluate(cdp,"(() => {const inputs=document.querySelectorAll('.owner-form input[type=datetime-local]');const values="+JSON.stringify([date+"T09:00",date+"T12:00"])+";inputs.forEach((el,i)=>{el.value=values[i];el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});})()");
    await submitValidForm(cdp,".owner-form");
    await requireDom(cdp,"draft in publish selector","document.querySelector('[aria-label=\"Публикация смен staging\"] select')?.options.length===2 && document.querySelector('[aria-label=\"Публикация смен staging\"] input[type=checkbox]')");
    await evaluate(cdp,"(() => {const p=document.querySelector('[aria-label=\"Публикация смен staging\"]');const s=p.querySelector('select');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await requireDom(cdp,"draft selected","document.querySelector('[aria-label=\"Публикация смен staging\"] input[type=checkbox]')?.disabled===false");
    await evaluate(cdp,"document.querySelector('[aria-label=\"Публикация смен staging\"] input[type=checkbox]').click()");
    await button(cdp,"Опубликовать смену");
    await requireDom(cdp,"published shift","document.querySelector('[aria-label=\"Публикация смен staging\"] .list-items')?.innerText.includes('Опубликовано для staging')");
    await requireDom(cdp,"preview selector","document.querySelector('[aria-label=\"Публикация смен staging\"] input[type=date]')");
    await evaluate(cdp,"(() => {const p=document.querySelector('[aria-label=\"Публикация смен staging\"]');const s=p.querySelector('select');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));const d=p.querySelector('input[type=date]');d.value="+JSON.stringify(date)+";d.dispatchEvent(new Event('input',{bubbles:true}));d.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await button(cdp,"Проверить слоты");
    await requireDom(cdp,"server calculated available slots","document.body.innerText.includes('Найдено слотов: 9.')");
    const persistedShift=await pool.query("SELECT id::text, active FROM cookie_scheduling.shift_windows WHERE tenant_id=$1::uuid",[owner.tenantId]);
    assert.equal(persistedShift.rowCount,1);
    assert.equal(persistedShift.rows[0].active,true);
    await checkWidth(cdp,"real staging schedule");
    await checkLabeledControls(cdp,"real staging schedule");
    await button(cdp,"Мастера");
    await button(cdp,"Расписание");
    await requireDom(cdp,"published shift persists on navigation","document.querySelector('[aria-label=\"Публикация смен staging\"] .list-items')?.innerText.includes('Опубликовано для staging')");

    assert.deepEqual(external, [], "Unexpected real-mode external network requests");
    assert.deepEqual(errors, [], "Unexpected browser runtime errors");
    await button(cdp, "Выйти");
    await requireDom(cdp, "final logout", "document.body.innerText.includes('Вы вышли')");
    console.log("PASS real owner browser: invalid proof denied, HMAC/bearer, Service+Staff create/edit, staging capacity activation, shift publication, server availability and PostgreSQL persistence across API restart, 3 viewport checks, server logout.");
  } finally {
    if (cdp) cdp.close();
    if (chrome && !chrome.killed) chrome.kill("SIGTERM");
    try { await stopServer(api); } finally {
      await pool.end();
      await pause(300);
      rmSync(browserData, { recursive: true, force: true });
    }
  }
}

// Avoid printing network bodies, env, tokens or browser DOM after failures.
main().catch((error) => {
  console.error("Real owner browser smoke failed: " + error.message);
  process.exitCode = 1;
});
