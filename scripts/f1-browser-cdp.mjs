// Test-only Chromium driver: genuine Svelte BookingForm click into synthetic PostgreSQL.
// No production UI, external network, accounts, payments, or browser automation library.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { startChromiumWithRetry } from "./f1-chromium-startup.mjs";

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

// A profile cannot be deleted while an unreaped browser still owns it.
// Fail the test if even SIGKILL cannot reap the child: do not launch a
// second process against a potentially still-running first attempt.
async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
  const closed = new Promise((resolve) => chrome.once("close", resolve));
  chrome.kill("SIGTERM");
  await Promise.race([closed, sleep(800)]);
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGKILL");
    await Promise.race([closed, sleep(800)]);
  }
  if (chrome.exitCode === null && chrome.signalCode === null) {
    throw new Error("Chromium child could not be reaped");
  }
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
 * @returns {Promise<{bookingId?:string, receipt?:string, requests:number, outcome:string}>}
 * AuthN is a synthetic test-only bearer verified by the injected Fastify app.
 */
export async function runF1BrowserBooking(url, syntheticBearer, options = {}) {
  const slotTime = options.slotTime ?? "10:00";
  const outcome = options.outcome ?? "confirmed";
  const beforeSubmit = options.beforeSubmit;
  assert.ok(["confirmed", "conflict", "denied"].includes(outcome));
  assert.ok(/^\d{2}:\d{2}$/.test(slotTime));
  const page = new URL(url);
  assert.equal(page.protocol, "http:");
  assert.equal(page.hostname, "127.0.0.1");
  assert.ok(!page.searchParams.has("syntheticBearer"), "Test bearer must not be in URL");
  assert.equal(syntheticBearer, "synthetic-owner");
  let browserDataDir;
  let chromeLogs = [];
  const runtimeErrors = [];
  const networkFailures = [];
  let chrome;
  let cdp;
  try {
    const executable = browserBinary();
    // Bounded retry covers Chrome launch + CDP discovery ONLY. Once a
    // WebSocket is returned, every Svelte/UI/API/DB assertion runs once.
    const started = await startChromiumWithRetry({
      attempts: 2,
      startupTimeoutMs: 12000,
      intervalMs: 100,
      startAttempt: async () => {
        const dir = mkdtempSync(join(tmpdir(), "cookie-f1-pg-browser-"));
        let process;
        try {
          process = spawn(executable, [
            "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
            "--disable-background-networking", "--no-first-run",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            "--user-data-dir=" + dir, "about:blank",
          ], { stdio: ["ignore", "ignore", "pipe"] });
        } catch (error) {
          rmSync(dir, { recursive: true, force: true });
          throw error;
        }
        const handle = { chrome: process, dir, logs: [], startupError: null };
        process.stderr.on("data", (chunk) => {
          handle.logs.push(String(chunk).slice(0, 500));
          if (handle.logs.length > 20) handle.logs.shift();
        });
        process.on("error", (error) => { handle.startupError = error.message; });
        return handle;
      },
      probe: async ({ dir }) => {
        // Chrome owns the ephemeral port and writes DevToolsActivePort;
        // never reserve/release a guessed port in this test process.
        const portFile = join(dir, "DevToolsActivePort");
        if (!existsSync(portFile)) return null;
        const firstLine = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
        const port = Number(firstLine);
        if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
        const result = await getLocal("http://127.0.0.1:" + port + "/json/list");
        if (result.code !== 200) return null;
        return JSON.parse(result.body).find(
          (x) => x.type === "page" && x.webSocketDebuggerUrl,
        );
      },
      disposeAttempt: async ({ chrome: child, dir }) => {
        try {
          await stopChrome(child);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    });
    chrome = started.handle.chrome;
    chromeLogs = started.handle.logs;
    browserDataDir = started.handle.dir;
    cdp = connect(started.ready.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        'Object.defineProperty(window, "__COOKIE_F1_SYNTHETIC_BEARER__", ' +
        JSON.stringify({
          value: syntheticBearer,
          writable: false,
          configurable: false,
          enumerable: false,
        }) +
        ')',
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    const external = [];
    let bookingPosts = 0;
    let availabilityGets = 0;
    const bookingPostIds = new Set();
    const bookingHttpStatuses = [];
    const availabilityRequests = new Map();
    const refreshedAvailabilityBodies = [];
    const refreshedAvailabilityErrors = [];
    cdp.on("Runtime.exceptionThrown", (event) => {
      runtimeErrors.push(event?.exceptionDetails?.exception?.description ?? event?.exceptionDetails?.text);
    });
    cdp.on("Network.loadingFailed", (event) => {
      networkFailures.push(event?.errorText ?? "unknown request failure");
      const availability = availabilityRequests.get(event.requestId);
      if (availability?.afterConflict)
        refreshedAvailabilityErrors.push(event?.errorText ?? "availability loading failed");
    });
    cdp.on("Network.responseReceived", ({ requestId, response }) => {
      if (bookingPostIds.has(requestId)) bookingHttpStatuses.push(response.status);
      const availability = availabilityRequests.get(requestId);
      if (availability) availability.status = response.status;
      if (response?.status >= 400)
        networkFailures.push(response.status + " " + response.url);
    });
    cdp.on("Network.loadingFinished", ({ requestId }) => {
      const availability = availabilityRequests.get(requestId);
      if (!availability?.afterConflict || availability.status !== 200) return;
      // Read the actual browser HTTP response body, not a new Node-side GET
      // or a locally reconstructed/stale slot list. loadingFinished ensures
      // Network.getResponseBody can retrieve this exact request's payload.
      void cdp.send("Network.getResponseBody", { requestId })
        .then((result) => {
          const raw = result.base64Encoded
            ? Buffer.from(result.body, "base64").toString("utf8")
            : result.body;
          refreshedAvailabilityBodies.push({
            ...availability,
            body: JSON.parse(raw),
          });
        })
        .catch((error) => refreshedAvailabilityErrors.push(error.message));
    });
    cdp.on("Network.requestWillBeSent", ({ request, requestId }) => {
      if (!request?.url?.startsWith("http")) return;
      const parsed = new URL(request.url);
      if (parsed.hostname !== "127.0.0.1") external.push(request.url);
      if (request.url.includes(syntheticBearer)) external.push("Synthetic bearer leaked in request URL");
      if (request.method === "GET" && parsed.pathname.endsWith("/availability")) {
        availabilityGets++;
        availabilityRequests.set(requestId, {
          url: request.url,
          afterConflict: bookingHttpStatuses.includes(409),
          status: null,
        });
      }
      if (parsed.pathname.includes("/v1/organizations/") && request.method === "POST") {
        bookingPosts++;
        bookingPostIds.add(requestId);
      }
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 375, height: 812, deviceScaleFactor: 1,
      mobile: false, screenWidth: 375, screenHeight: 812,
    });
    await cdp.send("Page.navigate", { url });
    await poll("Svelte form and server-side available slots", async () =>
      evaluate(cdp, `(() => {
        const buttons = [...document.querySelectorAll(".booking-form .slot-grid button")];
        return !!buttons.find((element) => element.textContent?.trim() === ${JSON.stringify(slotTime)});
      })()`), 25000);
    const slotClicked = await evaluate(cdp, `(() => {
      const buttons = [...document.querySelectorAll(".booking-form .slot-grid button")];
      const target = buttons.find((button) => button.textContent?.trim() === ${JSON.stringify(slotTime)});
      if (!target) return false;
      target.focus();
      target.click();
      return true;
    })()`);
    assert.equal(slotClicked, true, "Expected " + slotTime + " to remain an available server slot");
    await poll("Svelte selected slot", async () =>
      evaluate(cdp, "Boolean(document.querySelector('.booking-form .slot-grid button[aria-pressed=true]'))"));
    const formReady = await evaluate(cdp, `(() => {
      const form = document.querySelector(".booking-form");
      return form?.checkValidity() && !form.querySelector("button[type=submit]")?.disabled;
    })()`);
    assert.equal(formReady, true, "Synthetic Svelte BookingForm must be valid");

    // The selected slot came from the backend before the test callback.
    // Another actor can reserve it or revoke this actor's permission before
    // the user clicks Submit. This is a real browser→API negative-path gate.
    if (beforeSubmit) await beforeSubmit();
    const availabilityGetsBeforeSubmit = availabilityGets;
    await click(cdp, ".booking-form button[type=submit]");
    if (outcome !== "confirmed") {
      const title = outcome === "conflict"
        ? "Выбранное время больше недоступно"
        : "Операция недоступна";
      await poll("Svelte shows verified " + outcome + " without Confirmed", async () =>
        evaluate(cdp, `(() => {
          const card = document.querySelector(".booking-attempt-status");
          return card?.textContent?.includes(${JSON.stringify(title)}) &&
            !card.textContent.includes("Запись подтверждена") &&
            !card.querySelector(".booking-attempt-receipt");
        })()`), 25000);
      if (outcome === "conflict") {
        const choices = await evaluate(cdp,
          "document.querySelectorAll('.booking-attempt-slot-options button').length");
        assert.ok(choices > 0, "409 must offer freshly fetched backend availability");
        assert.ok(
          availabilityGets > availabilityGetsBeforeSubmit,
          "409 must refetch availability over HTTP after the conflicting Booking POST",
        );
        const refreshed = await poll("CDP body of post-409 backend availability", () =>
          refreshedAvailabilityBodies.find((entry) => entry.afterConflict), 10000);
        assert.deepEqual(
          refreshedAvailabilityErrors,
          [],
          "A post-409 availability HTTP body must be readable from CDP",
        );
        const initial = [...availabilityRequests.values()].find((entry) => !entry.afterConflict);
        assert.ok(initial, "Expected an initial backend availability request");
        const originalUrl = new URL(initial.url);
        const refreshedUrl = new URL(refreshed.url);
        assert.equal(refreshed.status, 200, "Post-409 availability must return HTTP 200");
        assert.equal(refreshedUrl.pathname, originalUrl.pathname, "Refresh must use the same tenant and Location");
        for (const key of ["serviceId", "staffId", "date"]) {
          assert.equal(
            refreshedUrl.searchParams.get(key),
            originalUrl.searchParams.get(key),
            "Refresh must preserve the original " + key,
          );
        }
        assert.ok(
          Array.isArray(refreshed.body?.slots),
          "CDP response body must contain actual backend slots",
        );
        const serverTimes = refreshed.body.slots.map((slot) => {
          assert.match(slot.startAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
          return slot.startAt.slice(11, 16);
        });
        const displayedTimes = await evaluate(cdp, `[...document.querySelectorAll(".booking-attempt-slot-options button")].map((button) => button.textContent?.trim())`);
        assert.deepEqual(
          displayedTimes,
          serverTimes,
          "Every visible 409 alternative must equal the fresh browser-received backend slots",
        );
        assert.equal(
          serverTimes.includes(slotTime),
          false,
          "Fresh backend availability must exclude the newly committed staff slot",
        );
      }
      assert.equal(bookingPosts, 1, "One POST only; no implicit retry or duplicate");
      assert.deepEqual(
        bookingHttpStatuses,
        [outcome === "conflict" ? 409 : 403],
        "Network.responseReceived must prove the real Booking POST status, not only UI text",
      );
      assert.deepEqual(external, [], "Synthetic client must not make external requests");
      assert.deepEqual(runtimeErrors, [], "Forbidden/conflict must be handled by Svelte");
      const layout = await evaluate(cdp, "({width:innerWidth, scrollWidth:document.documentElement.scrollWidth})");
      assert.ok(layout.scrollWidth <= layout.width + 1, "Svelte negative state overflows mobile viewport");
      return { outcome, requests: bookingPosts };
    }
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
    assert.deepEqual(bookingHttpStatuses, [201], "Real Booking POST must return 201");
    assert.deepEqual(external, [], "Test browser must not request external hosts");
    assert.deepEqual(runtimeErrors, [], "Browser must not emit uncaught Svelte exceptions");
    const layout = await evaluate(cdp, "({width:innerWidth, scrollWidth:document.documentElement.scrollWidth})");
    assert.ok(layout.scrollWidth <= layout.width + 1, "Svelte synthetic form overflows mobile viewport");
    return { outcome: "confirmed", bookingId, receipt, requests: bookingPosts };
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
    try {
      await stopChrome(chrome);
    } finally {
      if (browserDataDir) rmSync(browserDataDir, { recursive: true, force: true });
    }
  }
}
