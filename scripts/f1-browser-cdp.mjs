// Test-only Chromium driver: genuine Svelte BookingForm click into synthetic PostgreSQL.
// No production UI, external network, accounts, payments, or browser automation library.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  await new Promise((ok) => server.close(ok));
  if (!address || typeof address === "string") throw new Error("No local Chrome port");
  return address.port;
}

function browserBinary() {
  const choices = [
    process.env.COOKIE_BROWSER_BINARY,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);
  for (const candidate of choices) {
    const found = spawnSync("which", [candidate], { encoding: "utf8" });
    if (found.status === 0) return found.stdout.trim();
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chromium binary is required for F1 browser-to-PostgreSQL QA");
}

function getLocal(url) {
  return new Promise((ok, fail) => {
    const req = httpGet(url, { timeout: 1800 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => ok({ code: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", fail);
    });
    req.on("timeout", () => req.destroy(new Error("Local GET timed out")));
    req.on("error", fail);
  });
}

async function poll(label, fn, timeout = 20000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try {
      const data = await fn();
      if (data) return data;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(label + " timed out" + (lastError ? ": " + lastError.message : ""));
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = new Map();
  const ready = new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    if (!msg.id) {
      for (const fn of events.get(msg.method) ?? []) fn(msg.params);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.fail(new Error(msg.error.message));
    else p.ok(msg.result);
  });
  return {
    ready,
    on(method, fn) { events.set(method, [...(events.get(method) ?? []), fn]); },
    send(method, params = {}) {
      return new Promise((ok, fail) => {
        const next = ++id;
        pending.set(next, { ok, fail });
        ws.send(JSON.stringify({ id: next, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error("Browser JS failed: " + res.exceptionDetails.text);
  }
  return res.result.value;
}

async function click(cdp, selector) {
  const done = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    element.click();
    return true;
  })()`);
  assert.equal(done, true, "Missing real Svelte button: " + selector);
}

/**
 * @returns {Promise<{bookingId:string, receipt:string, requests:number}>}
 * AuthN is a synthetic test-only bearer verified by the injected Fastify app.
 */
export async function runF1BrowserBooking(url) {
  const chromePort = await freePort();
  const browserDataDir = mkdtempSync(join(tmpdir(), "cookie-f1-pg-browser-"));
  const chromeLogs = [];
  const runtimeErrors = [];
  const networkFailures = [];
  let chrome;
  let cdp;
  try {
    chrome = spawn(browserBinary(), [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-networking", "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=" + chromePort,
      "--user-data-dir=" + browserDataDir, "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    chrome.stderr.on("data", (chunk) => chromeLogs.push(String(chunk).slice(0, 500)));
    const target = await poll("Chrome DevTools", async () => {
      const result = await getLocal("http://127.0.0.1:" + chromePort + "/json/list");
      return JSON.parse(result.body).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
    });
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    const external = [];
    let bookingPosts = 0;
    cdp.on("Runtime.exceptionThrown", (event) => {
      runtimeErrors.push(event?.exceptionDetails?.exception?.description ?? event?.exceptionDetails?.text);
    });
    cdp.on("Network.loadingFailed", (event) => {
      networkFailures.push(event?.errorText ?? "unknown request failure");
    });
    cdp.on("Network.responseReceived", ({ response }) => {
      if (response?.status >= 400)
        networkFailures.push(response.status + " " + response.url);
    });
    cdp.on("Network.requestWillBeSent", ({ request }) => {
      if (!request?.url?.startsWith("http")) return;
      const host = new URL(request.url).hostname;
      if (host !== "127.0.0.1") external.push(request.url);
      if (request.url.includes("/v1/organizations/") && request.method === "POST") bookingPosts++;
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 375, height: 812, deviceScaleFactor: 1,
      mobile: false, screenWidth: 375, screenHeight: 812,
    });
    await cdp.send("Page.navigate", { url });
    await poll("Svelte form and server-side available slots", async () =>
      evaluate(cdp, `(() => {
        const buttons = [...document.querySelectorAll(".booking-form .slot-grid button")];
        return !!buttons.find((element) => element.textContent?.trim() === "10:00");
      })()`), 25000);
    const slotClicked = await evaluate(cdp, `(() => {
      const buttons = [...document.querySelectorAll(".booking-form .slot-grid button")];
      const target = buttons.find((button) => button.textContent?.trim() === "10:00");
      if (!target) return false;
      target.focus();
      target.click();
      return true;
    })()`);
    assert.equal(slotClicked, true, "Expected 10:00 to remain an available server slot");
    await poll("Svelte selected slot", async () =>
      evaluate(cdp, "Boolean(document.querySelector('.booking-form .slot-grid button[aria-pressed=true]'))"));
    const formReady = await evaluate(cdp, `(() => {
      const form = document.querySelector(".booking-form");
      return form?.checkValidity() && !form.querySelector("button[type=submit]")?.disabled;
    })()`);
    assert.equal(formReady, true, "Synthetic Svelte BookingForm must be valid");
    await click(cdp, ".booking-form button[type=submit]");
    const receipt = await poll("Server-confirmed receipt rendered by Svelte UI", async () =>
      evaluate(cdp, `(() => {
        const card = document.querySelector(".booking-attempt-status");
        if (!card?.textContent?.includes("Запись подтверждена")) return null;
        return card.querySelector(".booking-attempt-receipt")?.textContent ?? null;
      })()`), 25000);
    const bookingId = await evaluate(cdp,
      'document.querySelector(".booking-attempt-receipt dd")?.textContent?.trim()');
    assert.match(bookingId, /^[0-9a-f-]{36}$/);
    assert.ok(receipt.includes("1\u00a0755,55 ₽"), "UI must display real committed base price");
    assert.ok(receipt.includes("13.04.2027, 10:00 UTC"), "UI must display backend-confirmed UTC start");
    assert.ok(bookingPosts === 1, "Exactly one browser-originated CreateBooking POST");
    assert.deepEqual(external, [], "Test browser must not request external hosts");
    assert.deepEqual(runtimeErrors, [], "Browser must not emit uncaught Svelte exceptions");
    const layout = await evaluate(cdp, "({width:innerWidth, scrollWidth:document.documentElement.scrollWidth})");
    assert.ok(layout.scrollWidth <= layout.width + 1, "Svelte synthetic form overflows mobile viewport");
    return { bookingId, receipt, requests: bookingPosts };
  } catch (error) {
    if (cdp) {
      try {
        const diagnostics = await evaluate(cdp, "({url:location.href,text:document.body.innerText.slice(0,1800)})");
        console.error("F1 SYNTHETIC BROWSER", JSON.stringify(diagnostics));
      } catch {}
    }
    console.error("F1 RUNTIME ERRORS", JSON.stringify(runtimeErrors.slice(0, 10)));
    console.error("F1 NETWORK FAILURES", JSON.stringify(networkFailures.slice(0, 20)));
    console.error("F1 CHROME", chromeLogs.join("").slice(-1200));
    throw error;
  } finally {
    cdp?.close();
    if (chrome && !chrome.killed) chrome.kill("SIGTERM");
    await sleep(250);
    rmSync(browserDataDir, { recursive: true, force: true });
  }
}
