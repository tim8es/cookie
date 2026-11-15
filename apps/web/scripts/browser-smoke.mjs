// Browser-driven synthetic UX regression. Zero additional npm packages.
// Serve the compiled Vite bundle using local Node HTTP; connect to loopback Chrome DevTools.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const webDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(webDir, "dist");
const browserCandidates = [
  process.env.COOKIE_BROWSER_BINARY,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
].filter(Boolean);

function browserBinary() {
  for (const candidate of browserCandidates) {
    const found = spawnSync("which", [candidate], { encoding: "utf8" });
    if (found.status === 0) return found.stdout.trim();
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Headless Chrome/Chromium is required for the browser smoke test");
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolvePort(port) : reject(new Error("No local port"))));
    });
  });
}

function staticResponse(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const pathname = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  // Only compiled Vite assets. Reject traversal and unexpected paths.
  if (!/^[a-zA-Z0-9._/-]+$/.test(pathname) || pathname.split("/").includes("..")) {
    response.writeHead(403).end();
    return;
  }
  const filePath = join(distDir, pathname);
  if (!existsSync(filePath)) {
    response.writeHead(404).end();
    return;
  }
  const contentType = pathname.endsWith(".js")
    ? "text/javascript; charset=utf-8"
    : pathname.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/html; charset=utf-8";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
}

async function poll(description, condition, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await pause(90);
  }
  throw new Error("Timeout: " + description + (lastError ? " (" + lastError.message + ")" : ""));
}

/** Node's direct loopback HTTP client avoids any environment-wide fetch proxy. */
function getLocal(url) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpGet(url, { timeout: 1500 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveResponse({
        status: response.statusCode,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", rejectResponse);
    });
    request.on("timeout", () => request.destroy(new Error("Local HTTP timeout")));
    request.on("error", rejectResponse);
  });
}

async function waitForHttp(url) {
  await poll("Vite preview on " + url, async () => {
    const response = await getLocal(url);
    return response.status === 200;
  }, 18000);
}

function createClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", rejectReady, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    if (!packet.id || !pending.has(packet.id)) return;
    const entry = pending.get(packet.id);
    pending.delete(packet.id);
    if (packet.error) entry.reject(new Error(packet.error.message));
    else entry.resolve(packet.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) entry.reject(new Error("Browser socket closed"));
    pending.clear();
  });
  return {
    ready,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolveSend, rejectSend) => {
        pending.set(id, { resolve: resolveSend, reject: rejectSend });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  }
  return response.result.value;
}

async function requireDom(cdp, name, expression) {
  return poll(name, () => evaluate(cdp, "Boolean(" + expression + ")"));
}

async function click(cdp, selector) {
  const clicked = await evaluate(cdp, "(() => {const item = document.querySelector(" +
    JSON.stringify(selector) + "); if (!item) return false; item.click(); return true;})()");
  assert.equal(clicked, true, "Button missing: " + selector);
}

async function fill(cdp, selector, value, eventName = "input") {
  const changed = await evaluate(cdp, "(() => {const item = document.querySelector(" +
    JSON.stringify(selector) + "); if (!item) return false; item.value = " +
    JSON.stringify(value) + "; item.dispatchEvent(new Event(" +
    JSON.stringify(eventName) + ", {bubbles:true})); return true;})()");
  assert.equal(changed, true, "Input missing: " + selector);
}

async function checkWidth(cdp, screen) {
  const metrics = await evaluate(cdp, "({width:innerWidth, doc:document.documentElement.scrollWidth, body:document.body.scrollWidth})");
  assert.ok(
    metrics.doc <= metrics.width + 1 && metrics.body <= metrics.width + 1,
    screen + ": document overflow " + JSON.stringify(metrics),
  );
}

async function keyboard(cdp, key, virtualCode) {
  const params = {
    key, code: key, windowsVirtualKeyCode: virtualCode, nativeVirtualKeyCode: virtualCode,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

async function scenario(cdp, origin, width, height) {
  const name = width + "x" + height;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: width < 600,
  });
  await cdp.send("Page.navigate", { url: origin + "?browser-smoke=" + name });
  await requireDom(cdp, name + " onboarding", "document.querySelector('.welcome-form')");
  await checkWidth(cdp, name + " welcome");

  await fill(cdp, ".welcome-form input", "Студия Smoke " + name);
  await click(cdp, ".welcome-form button[type=submit]");
  await requireDom(cdp, name + " services", "document.querySelector('.section-head h1')?.textContent === 'Услуги и цены'");
  await checkWidth(cdp, name + " services");

  await click(cdp, ".workspace-grid form button[type=submit]");
  await requireDom(cdp, name + " staff", "document.querySelector('.section-head h1')?.textContent === 'Мастера'");
  await click(cdp, ".workspace-grid form button[type=submit]");
  await requireDom(cdp, name + " schedule", "document.querySelector('.section-head h1')?.textContent === 'Расписание'");
  await click(cdp, ".workspace-grid form button[type=submit]");

  await requireDom(cdp, name + " synthetic slots", "document.querySelector('.booking-form .slot-grid button')");
  await checkWidth(cdp, name + " booking");
  await click(cdp, ".booking-form .slot-grid button");
  await requireDom(cdp, name + " selected slot", "document.querySelector('.booking-form .slot-grid button[aria-pressed=true]')");
  await click(cdp, ".booking-form button[type=submit]");
  await requireDom(cdp, name + " synthetic success", "document.querySelector('.success-screen')?.textContent.includes('не подтверждена backend')");

  await click(cdp, ".success-screen .btn-primary");
  await requireDom(cdp, name + " calendar event", "document.querySelector('.calendar-event')");
  await checkWidth(cdp, name + " calendar");
  await click(cdp, ".calendar-event");
  await requireDom(cdp, name + " calendar detail", "document.querySelector('[role=dialog] .close-button')");
  await requireDom(cdp, name + " dialog initial focus", "document.activeElement?.classList.contains('close-button')");
  await keyboard(cdp, "Escape", 27);
  await poll(name + " Escape closes modal", async () =>
    !(await evaluate(cdp, "Boolean(document.querySelector('[role=dialog]'))")));
  await requireDom(cdp, name + " dialog focus restored", "document.activeElement?.classList.contains('calendar-event')");

  await click(cdp, ".segmented button:first-child");
  await requireDom(cdp, name + " calendar day", "document.querySelector('.day-timeline .timeline-entry')");

  await cdp.send("Page.reload", { ignoreCache: true });
  await requireDom(cdp, name + " restored synthetic booking", "document.querySelectorAll('.stat-card')[2]?.querySelector('strong')?.textContent === '01'");
  await checkWidth(cdp, name + " restored home");

  await fill(cdp, ".preview-control select", "error", "change");
  await requireDom(cdp, name + " error preview", "document.querySelector('.state-card')?.textContent.includes('ошибка загрузки')");
  await click(cdp, ".state-card button");
  await fill(cdp, ".preview-control select", "forbidden", "change");
  await requireDom(cdp, name + " forbidden preview", "document.querySelector('.state-card')?.textContent.includes('недостаточно прав')");
  await click(cdp, ".state-card button");

  await click(cdp, ".footer button");
  await requireDom(cdp, name + " reset", "document.querySelector('.welcome-form')");
  assert.equal(await evaluate(cdp, "sessionStorage.getItem('cookie.frontend-demo.v1')"), null);

  console.log("PASS browser viewport " + name + ": onboarding → booking → calendar → dialog → reload → preview → reset");
}

async function main() {
  assert.ok(existsSync(join(distDir, "index.html")), "Run pnpm build:web before smoke");
  const staticServer = createHttpServer(staticResponse);
  const previewPort = await new Promise((resolvePort, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(0, "127.0.0.1", () => {
      const address = staticServer.address();
      resolvePort(address.port);
    });
  });
  const chromePort = await freePort();
  const browserDataDir = mkdtempSync(join(tmpdir(), "cookie-browser-smoke-"));
  const chromeLogs = [];
  let chrome;
  let cdp;

  try {
    const origin = "http://127.0.0.1:" + previewPort + "/";
    await waitForHttp(origin);

    chrome = spawn(browserBinary(), [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-networking", "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=" + chromePort,
      "--user-data-dir=" + browserDataDir,
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    chrome.stdout.on("data", (chunk) => chromeLogs.push(String(chunk).slice(0, 1500)));
    chrome.stderr.on("data", (chunk) => chromeLogs.push(String(chunk).slice(0, 1500)));
    const target = await poll("Chrome DevTools page target", async () => {
      const response = await getLocal("http://127.0.0.1:" + chromePort + "/json/list");
      const pages = JSON.parse(response.text);
      return pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl);
    }, 20000);
    cdp = createClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    for (const [width, height] of [[1280, 800], [375, 812], [320, 568]]) {
      await scenario(cdp, origin, width, height);
    }
  } catch (error) {
    if (cdp) {
      try {
        const diagnostics = await evaluate(cdp,
          "({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,1600),width:innerWidth,scroll:document.documentElement.scrollWidth})");
        console.error("BROWSER DIAGNOSTICS", JSON.stringify(diagnostics));
      } catch { /* Best effort after browser crash/navigation. */ }
    }
    console.error("STATIC SERVER", JSON.stringify({ port: previewPort, listening: staticServer.listening }));
    console.error("CHROME LOGS", chromeLogs.join("").slice(-2200));
    throw error;
  } finally {
    if (cdp) cdp.close();
    if (chrome && !chrome.killed) chrome.kill("SIGTERM");
    if (staticServer.listening) staticServer.close();
    await pause(300);
    rmSync(browserDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Cookie browser smoke failed:", error);
  process.exitCode = 1;
});
