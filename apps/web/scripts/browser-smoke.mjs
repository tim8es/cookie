// Browser-driven synthetic UX regression. Zero additional npm packages.
// Serve the compiled Vite bundle using local Node HTTP; connect to loopback Chrome DevTools.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const webDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(webDir, "dist");
const evidenceDir = join(webDir, "artifacts", "visual-smoke");
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
  const listeners = new Map();
  let nextId = 0;
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", rejectReady, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    if (!packet.id) {
      for (const fn of listeners.get(packet.method) ?? []) fn(packet.params);
      return;
    }
    if (!pending.has(packet.id)) return;
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
    onEvent(method, listener) {
      const list = listeners.get(method) ?? [];
      list.push(listener);
      listeners.set(method, list);
    },
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
    JSON.stringify(selector) + "); if (!item) return false; item.focus(); item.click(); return true;})()");
  assert.equal(clicked, true, "Button missing: " + selector);
}

async function submitValidForm(cdp, formSelector) {
  const invalid = await evaluate(cdp, "(() => {const form = document.querySelector(" +
    JSON.stringify(formSelector) + "); if (!form) return ['form missing']; return " +
    "Array.from(form.elements).filter((item) => item.willValidate && !item.checkValidity())" +
    ".map((item) => ({name:item.getAttribute('name'), value:item.value, error:item.validationMessage}));})()");
  assert.deepEqual(invalid, [], "Invalid native form state: " + formSelector);
  await click(cdp, formSelector + " button[type=submit]");
}

async function fill(cdp, selector, value, eventName = "input") {
  const changed = await evaluate(cdp, "(() => {const item = document.querySelector(" +
    JSON.stringify(selector) + "); if (!item) return false; item.value = " +
    JSON.stringify(value) + "; item.dispatchEvent(new Event(" +
    JSON.stringify(eventName) + ", {bubbles:true})); return true;})()");
  assert.equal(changed, true, "Input missing: " + selector);
}

async function checkMobileOwnerFormFirst(cdp, screen, width) {
  if (width > 680) return;
  const metrics = await evaluate(cdp, `(() => {
    const panel = document.querySelector(".workspace-grid > .owner-form-panel");
    const list = document.querySelector(".workspace-grid > .card");
    return { panel: panel?.getBoundingClientRect().top, list: list?.getBoundingClientRect().top };
  })()`);
  assert.ok(
    Number.isFinite(metrics.panel) && Number.isFinite(metrics.list) && metrics.panel < metrics.list,
    screen + ": owner form should be visible before catalog on mobile " + JSON.stringify(metrics),
  );
}

async function checkLabeledControls(cdp, screen) {
  const unlabeled = await evaluate(cdp, `(() => {
    const controls = [...document.querySelectorAll("button, input, select, textarea")];
    return controls.filter((item) => {
      if (!item.getClientRects().length || item.disabled || item.type === "hidden") return false;
      if (item.getAttribute("aria-label")?.trim() || item.getAttribute("aria-labelledby")) return false;
      if (item.tagName === "BUTTON") return !item.textContent?.trim();
      return !item.labels?.length;
    }).map((item) => item.outerHTML.slice(0, 200));
  })()`);
  assert.deepEqual(unlabeled, [], screen + ": interactive controls need accessible names");
}

async function captureEvidence(cdp, name, stage) {
  // Wait for short navigation transitions before taking deterministic visual evidence.
  // This is screenshot-only; interaction assertions run before the pause.
  await pause(250);
  const geometry = await evaluate(cdp, `({
    innerWidth: innerWidth,
    innerHeight: innerHeight,
    fullHeight: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
  })`);
  // Explicit clip prevents Chromium from expanding a mobile screenshot to
  // include horizontally scrollable child navigation beyond the viewport.
  const captureHeight = stage === "05-detail"
    ? geometry.innerHeight
    : Math.max(geometry.innerHeight, geometry.fullHeight);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
    clip: {
      x: 0,
      y: stage === "05-detail" ? geometry.scrollY : 0,
      width: geometry.innerWidth,
      height: captureHeight,
      scale: 1,
    },
  });
  const buffer = Buffer.from(screenshot.data, "base64");
  assert.ok(buffer.length > 1500, name + "/" + stage + ": screenshot is empty");
  // PNG IHDR width/height; reject visually misleading "mobile" captures.
  assert.equal(buffer.readUInt32BE(16), geometry.innerWidth, name + "/" + stage + ": wrong screenshot width");
  assert.equal(buffer.readUInt32BE(20), captureHeight, name + "/" + stage + ": wrong screenshot height");
  writeFileSync(join(evidenceDir, name + "-" + stage + ".png"), buffer);
}

async function checkWidth(cdp, screen) {
  const metrics = await evaluate(cdp, "({width:innerWidth, doc:document.documentElement.scrollWidth, body:document.body.scrollWidth})");
  if (metrics.doc > metrics.width + 1 || metrics.body > metrics.width + 1) {
    const containers = await evaluate(cdp, `(() => {
      return [".app-shell", ".sidebar", ".nav-links", ".main-area", ".content",
        ".welcome-grid", ".workspace-grid", ".booking-layout"].map((name) => {
        const element = document.querySelector(name);
        return {name, width: element?.clientWidth, scrollWidth: element?.scrollWidth,
          right: Math.round(element?.getBoundingClientRect().right ?? 0)};
      });
    })()`);
    assert.fail(screen + ": document overflow " + JSON.stringify({metrics, containers}));
  }
}

async function keyboard(cdp, key, virtualCode, modifiers = 0) {
  const params = {
    key, code: key, windowsVirtualKeyCode: virtualCode, nativeVirtualKeyCode: virtualCode, modifiers,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

async function scenario(cdp, origin, width, height) {
  const name = width + "x" + height;
  // Exercise true CSS viewport widths. Chrome's mobile=true mode on this
  // runner falls back to ~800 CSS pixels despite a smaller width override.
  // Responsive coverage intentionally tests 320/375 CSS px, not touch UX.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
    screenWidth: width, screenHeight: height,
  });
  await cdp.send("Page.navigate", { url: origin + "?browser-smoke=" + name });
  await requireDom(cdp, name + " onboarding", "document.querySelector('.welcome-form')");
  await requireDom(cdp, name + " standalone welcome header", "document.querySelector('.onboarding-header') && !document.querySelector('.sidebar')");
  const dimensions = await evaluate(cdp, "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })");
  assert.equal(dimensions.width, width, name + ": Chromium mobile emulation used wrong CSS viewport");
  assert.equal(dimensions.height, height, name + ": Chromium emulation used wrong viewport height");
  await checkWidth(cdp, name + " welcome");
  await checkLabeledControls(cdp, name + " welcome");
  await captureEvidence(cdp, name, "01-onboarding");

  await fill(cdp, ".welcome-form input", "Студия Smoke " + name);
  await submitValidForm(cdp, ".welcome-form");
  await requireDom(cdp, name + " services", "document.querySelector('.section-head h1')?.textContent === 'Услуги и цены'");
  await checkWidth(cdp, name + " services");
  await checkLabeledControls(cdp, name + " services");
  await checkMobileOwnerFormFirst(cdp, name + " services", width);
  await captureEvidence(cdp, name, "08-services");

  await submitValidForm(cdp, ".workspace-grid form");
  await requireDom(cdp, name + " staff", "document.querySelector('.section-head h1')?.textContent === 'Мастера'");
  await checkWidth(cdp, name + " staff");
  await checkLabeledControls(cdp, name + " staff");
  await checkMobileOwnerFormFirst(cdp, name + " staff", width);
  await captureEvidence(cdp, name, "09-staff");
  await submitValidForm(cdp, ".workspace-grid form");
  await requireDom(cdp, name + " schedule", "document.querySelector('.section-head h1')?.textContent === 'Расписание'");
  await checkWidth(cdp, name + " schedule");
  await checkLabeledControls(cdp, name + " schedule");
  await checkMobileOwnerFormFirst(cdp, name + " schedule", width);
  await captureEvidence(cdp, name, "10-schedule");
  await submitValidForm(cdp, ".workspace-grid form");

  await requireDom(cdp, name + " synthetic slots", "document.querySelector('.booking-form .slot-grid button')");
  await checkWidth(cdp, name + " booking");
  await checkLabeledControls(cdp, name + " booking");
  await requireDom(cdp, name + " modular public hero", "document.querySelector('section.booking-hero .booking-hero-studio strong')?.textContent.includes('Студия Smoke')");
  await captureEvidence(cdp, name, "02-booking");
  await click(cdp, ".booking-form .slot-grid button");
  await requireDom(cdp, name + " selected slot", "document.querySelector('.booking-form .slot-grid button[aria-pressed=true]')");
  await submitValidForm(cdp, ".booking-form");
  await requireDom(cdp, name + " synthetic success", "document.querySelector('.success-screen')?.textContent.includes('не подтверждена backend')");
  await requireDom(cdp, name + " extracted confirmation", "document.querySelector('.booking-confirmation .confirmation-receipt')");
  await captureEvidence(cdp, name, "03-confirmation");

  await click(cdp, ".success-screen .btn-primary");
  await requireDom(cdp, name + " calendar event", "document.querySelector('.calendar-event')");
  await requireDom(cdp, name + " shared calendar card", "document.querySelector('.calendar-surface[data-slot=card]')");
  if (width <= 980) {
    await requireDom(cdp, name + " independently scrollable week", "(() => { const node = document.querySelector('.calendar-week-scroller'); return node && node.scrollWidth > node.clientWidth && node.tabIndex === 0; })()");
  }
  await checkWidth(cdp, name + " calendar");
  await checkLabeledControls(cdp, name + " calendar");
  await captureEvidence(cdp, name, "04-calendar-week");
  await click(cdp, ".calendar-event");
  await requireDom(cdp, name + " calendar detail", "document.querySelector('[role=dialog] .close-button')");
  await requireDom(cdp, name + " accessible dialog", "document.querySelector('.calendar-detail-sheet[role=dialog][aria-modal=true][aria-labelledby][aria-describedby]')");
  await checkLabeledControls(cdp, name + " calendar detail");
  await checkWidth(cdp, name + " calendar detail");
  await requireDom(cdp, name + " dialog initial focus", "document.activeElement?.classList.contains('close-button')");
  await captureEvidence(cdp, name, "05-detail");
  await keyboard(cdp, "Tab", 9);
  await requireDom(cdp, name + " dialog focus second action", "document.activeElement?.classList.contains('btn-wide')");
  await keyboard(cdp, "Tab", 9);
  await requireDom(cdp, name + " dialog Tab wrapped", "document.activeElement?.classList.contains('close-button')");
  await keyboard(cdp, "Tab", 9, 8);
  await requireDom(cdp, name + " dialog Shift+Tab wrapped", "document.activeElement?.classList.contains('btn-wide')");
  await keyboard(cdp, "Escape", 27);
  await poll(name + " Escape closes modal", async () =>
    !(await evaluate(cdp, "Boolean(document.querySelector('[role=dialog]'))")));
  await requireDom(cdp, name + " dialog focus restored", "document.activeElement?.classList.contains('calendar-event')");

  await click(cdp, ".segmented button:first-child");
  await requireDom(cdp, name + " calendar day", "document.querySelector('.day-timeline .timeline-entry')");

  await captureEvidence(cdp, name, "06-calendar-day");
  await cdp.send("Page.reload", { ignoreCache: true });
  await requireDom(cdp, name + " restored synthetic booking", "document.querySelectorAll('.stat-card')[2]?.querySelector('strong')?.textContent === '01'");
  await checkWidth(cdp, name + " restored home");
  await checkLabeledControls(cdp, name + " workspace");
  await captureEvidence(cdp, name, "07-workspace");
  // Owner forms remain screen-local and never call the actual booking API.
  await click(cdp, ".nav-links button:nth-child(6)");
  await requireDom(cdp, name + " locations", "document.querySelector('.section-head h1')?.textContent === 'Филиалы'");
  await checkWidth(cdp, name + " locations");
  await checkLabeledControls(cdp, name + " locations");
  await checkMobileOwnerFormFirst(cdp, name + " locations", width);
  await captureEvidence(cdp, name, "11-locations");
  await click(cdp, ".nav-links button:first-child");

  await fill(cdp, ".preview-control select", "error", "change");
  await requireDom(cdp, name + " error preview", "document.querySelector('.state-card')?.textContent.includes('ошибка загрузки')");
  await checkLabeledControls(cdp, name + " error preview");
  await captureEvidence(cdp, name, "12-error-preview");
  await click(cdp, ".state-card button");
  await fill(cdp, ".preview-control select", "forbidden", "change");
  await requireDom(cdp, name + " forbidden preview", "document.querySelector('.state-card')?.textContent.includes('недостаточно прав')");
  await checkLabeledControls(cdp, name + " forbidden preview");
  await captureEvidence(cdp, name, "13-forbidden-preview");
  await click(cdp, ".state-card button");

  await click(cdp, ".footer button");
  await requireDom(cdp, name + " reset", "document.querySelector('.welcome-form')");
  assert.equal(await evaluate(cdp, "sessionStorage.getItem('cookie.frontend-demo.v1')"), null);

  console.log("PASS browser viewport " + name + ": onboarding → booking → calendar → dialog → reload → preview → reset");
}

async function main() {
  assert.ok(existsSync(join(distDir, "index.html")), "Run pnpm build:web before smoke");
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
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
    const runtimeErrors = [];
    cdp.onEvent("Runtime.exceptionThrown", (params) => {
      runtimeErrors.push(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? "unknown JS exception");
      console.error("PAGE RUNTIME ERROR", runtimeErrors[runtimeErrors.length - 1]);
    });
    await cdp.send("Network.enable");
    const externalUrls = [];
    let pageRequests = 0;
    cdp.onEvent("Network.requestWillBeSent", (params) => {
      const url = params?.request?.url;
      if (!url) return;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        pageRequests++;
        const hostname = new URL(url).hostname;
        if (hostname !== "127.0.0.1") externalUrls.push(url);
      }
    });
    for (const [width, height] of [[1280, 800], [375, 812], [320, 568]]) {
      await scenario(cdp, origin, width, height);
    }
    assert.deepEqual(externalUrls, [], "Synthetic frontend made external network requests");
    assert.deepEqual(runtimeErrors, [], "Frontend must not throw uncaught JavaScript exceptions");
    assert.ok(pageRequests >= 3, "Expected local JS/CSS/page requests to be observed");
    writeFileSync(join(evidenceDir, "manifest.json"), JSON.stringify({
      data: "synthetic sessionStorage only",
      backend: "not connected",
      chromium: "headless",
      viewports: ["1280x800", "375x812", "320x568"],
      captures: ["onboarding", "booking", "confirmation", "calendar-week", "detail", "calendar-day", "workspace", "services", "staff", "schedule", "locations", "error-preview", "forbidden-preview"],
      checks: ["end-to-end demo UI", "horizontal overflow", "accessible controls", "dialog keyboard", "no external requests", "zero uncaught page exceptions"],
      externalRequests: externalUrls.length,
    }, null, 2) + "\n");
    console.log("PASS evidence: 39 PNG screenshots and manifest; external requests =", externalUrls.length);
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
