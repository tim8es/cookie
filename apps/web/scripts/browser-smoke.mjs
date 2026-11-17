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
const distDir = join(webDir, ".tmp", "ui-fixture-dist");
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
  const pathname = ["/", "/demo", "/demo/"].includes(url.pathname) ? "index.html" : url.pathname.slice(1);
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
  // A full-page screenshot of a scrolled page paints position:sticky items
  // at their *scrolled* location. Reset only for full-document evidence:
  // otherwise the desktop summary appears hundreds of pixels below its
  // natural grid anchor, creating a false design regression.
  // The detail screenshot intentionally clips the current viewport.
  await pause(250);
  const scrollBefore = await evaluate(cdp, "window.scrollY");
  const fullDocument = stage !== "05-detail";
  if (fullDocument) {
    await evaluate(cdp, "window.scrollTo(0, 0)");
    await pause(90);
  }
  try {
    const geometry = await evaluate(cdp, `({
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      fullHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
    })`);
    if (fullDocument) {
      assert.equal(geometry.scrollY, 0, name + "/" + stage + ": screenshot must start at top");
    }
    if (stage === "02-booking" && geometry.innerWidth > 800) {
      const anchors = await evaluate(cdp, `(() => {
        const form = document.querySelector(".public-content .booking-panel");
        const summary = document.querySelector(".public-content .booking-summary-container");
        return { formTop: form?.getBoundingClientRect().top,
          summaryTop: summary?.getBoundingClientRect().top };
      })()`);
      assert.ok(
        Number.isFinite(anchors.formTop) &&
          Number.isFinite(anchors.summaryTop) &&
          Math.abs(anchors.summaryTop - anchors.formTop) <= 2,
        name + ": desktop visit summary must align with the form at scroll top " +
          JSON.stringify(anchors),
      );
    }
    // Explicit clip prevents Chromium from expanding a mobile screenshot to
    // include horizontally scrollable child navigation beyond the viewport.
    const captureHeight = fullDocument
      ? Math.max(geometry.innerHeight, geometry.fullHeight)
      : geometry.innerHeight;
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: 0,
        y: fullDocument ? 0 : geometry.scrollY,
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
  } finally {
    // Preserve interaction state: screenshots must not change the customer's
    // scrolling position for the next test step.
    if (fullDocument && scrollBefore > 0) {
      await evaluate(cdp, `window.scrollTo(0, ${scrollBefore})`);
    }
  }
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

async function checkEmbeddedClientInsets(cdp, screen) {
  // Simulate CSS variables delivered by an embedded Telegram viewport.
  // This tests responsive layout only, not Telegram SDK/authentication.
  const metrics = await evaluate(cdp, `(() => {
    const shell = document.querySelector(".public-shell");
    if (!shell) return null;
    const insets = {
      "--tg-content-safe-area-inset-top": "32px",
      "--tg-content-safe-area-inset-bottom": "24px",
      "--tg-content-safe-area-inset-left": "18px",
      "--tg-content-safe-area-inset-right": "20px",
    };
    for (const [name, value] of Object.entries(insets)) shell.style.setProperty(name, value);
    const header = document.querySelector(".public-header");
    const content = document.querySelector(".content.public-content");
    const headerStyle = getComputedStyle(header);
    const contentStyle = getComputedStyle(content);
    const result = {
      headerTop: parseFloat(headerStyle.paddingTop),
      contentBottom: parseFloat(contentStyle.paddingBottom),
      contentLeft: parseFloat(contentStyle.paddingLeft),
      contentRight: parseFloat(contentStyle.paddingRight),
    };
    for (const name of Object.keys(insets)) shell.style.removeProperty(name);
    return result;
  })()`);
  assert.ok(metrics, screen + ": missing embedded public shell");
  assert.ok(metrics.headerTop >= 32, screen + ": Telegram top content inset ignored");
  assert.ok(metrics.contentBottom >= 24, screen + ": Telegram bottom inset ignored");
  assert.ok(metrics.contentLeft >= 18 && metrics.contentRight >= 20,
    screen + ": Telegram horizontal insets ignored");
  await checkWidth(cdp, screen + " embedded safe-area");
  // Also verify Telegram insets in the optional, presentation-only Mini App shell.
  const previewInsets = await evaluate(cdp, `(() => {
    const shell = document.querySelector(".public-shell");
    const insets = {
      "--tg-content-safe-area-inset-top": "32px",
      "--tg-content-safe-area-inset-bottom": "24px",
      "--tg-content-safe-area-inset-left": "18px",
      "--tg-content-safe-area-inset-right": "20px",
    };
    shell.classList.add("telegramPreview");
    for (const [name, value] of Object.entries(insets)) shell.style.setProperty(name, value);
    const header = getComputedStyle(document.querySelector(".public-header"));
    const content = getComputedStyle(document.querySelector(".content.public-content"));
    const result = {
      top: parseFloat(header.paddingTop),
      bottom: parseFloat(content.paddingBottom),
      left: parseFloat(content.paddingLeft),
      right: parseFloat(content.paddingRight),
    };
    for (const name of Object.keys(insets)) shell.style.removeProperty(name);
    shell.classList.remove("telegramPreview");
    return result;
  })()`);
  assert.ok(previewInsets.top >= 32 && previewInsets.bottom >= 24, screen + ": Telegram preview vertical safe areas");
  assert.ok(previewInsets.left >= 18 && previewInsets.right >= 20, screen + ": Telegram preview horizontal safe areas");
  await checkWidth(cdp, screen + " embedded preview safe-area");
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
  await cdp.send("Page.navigate", { url: origin + "demo?browser-smoke=" + name });
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
  // Incomplete business setup is a neutral guest state, not a link into owner forms.
  await click(cdp, ".nav-links button:last-child");
  await requireDom(cdp, name + " unavailable booking state", "document.querySelector('.booking-unavailable[role=status]')?.textContent.includes('Онлайн-запись пока недоступна')");
  await requireDom(cdp, name + " no owner setup in public", "!document.querySelector('.setup-shortcut button, .booking-form, .booking-unavailable button')");
  await checkWidth(cdp, name + " unavailable booking");
  await captureEvidence(cdp, name, "16-unavailable-booking");
  await click(cdp, ".public-demo-back");
  await click(cdp, ".nav-links button:nth-child(3)");
  await requireDom(cdp, name + " returned to owner services", "document.querySelector('.section-head h1')?.textContent === 'Услуги и цены'");
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
  if (width <= 375) await checkEmbeddedClientInsets(cdp, name);
  await requireDom(cdp, name + " modular public hero", "document.querySelector('section.booking-hero .booking-hero-studio strong')?.textContent.includes('Студия Smoke')");
  await requireDom(cdp, name + " primary salon header", "document.querySelector('.public-header .salon-name')?.textContent.includes('Студия Smoke')");
  await requireDom(cdp, name + " salon identity mark", "document.querySelector('.public-header .salon-monogram')?.textContent.trim() === 'С'");
  await requireDom(cdp, name + " client header excludes owner navigation", "!document.querySelector('.public-header .public-back, .public-header .sidebar, .public-header .brand-seal')");
  await requireDom(cdp, name + " demo-only workspace escape", "document.querySelector('.public-demo-notice .public-demo-back')?.textContent.includes('тестовый кабинет')");
  await requireDom(cdp, name + " discreet public attribution", "document.querySelectorAll('.public-attribution').length === 1 && document.querySelector('.public-attribution')?.textContent.includes('Работает на Cookie')");
  await requireDom(cdp, name + " hero not branded Cookie", "!document.querySelector('.booking-hero')?.textContent.includes('Cookie / запись')");

  await requireDom(cdp, name + " location with address in booking receipt", "document.querySelector('.booking-summary .ticket-location-address')?.textContent.includes('Демонстрационный адрес')");
  if (width <= 680) {
    await requireDom(cdp, name + " expandable mobile receipt", "document.querySelector('.booking-summary-toggle[aria-expanded=false]')");
    await click(cdp, ".booking-summary-toggle");
    await requireDom(cdp, name + " expanded mobile receipt", "document.querySelector('.booking-summary-toggle[aria-expanded=true]')");
    await click(cdp, ".booking-summary-toggle");
  }
  await requireDom(cdp, name + " upfront base price", "document.querySelector('.booking-checkout-summary strong')?.textContent.includes('₽')");
  await requireDom(cdp, name + " service choices expose their catalog cost", "Array.from(document.querySelectorAll('.booking-form .booking-fields > label.field select option')).filter(item => item.value).every(item => item.textContent.includes('₽'))");
  await requireDom(cdp, name + " first selection shows duration and preliminary price", "document.querySelector('.booking-service-meta')?.textContent.includes('60 мин') && document.querySelector('.booking-service-meta')?.textContent.replaceAll(String.fromCharCode(160), ' ').includes('1 500 ₽')");
  await requireDom(cdp, name + " preliminary price appears before staff picker", "(() => { const meta = document.querySelector('.booking-service-meta'); const staff = document.querySelector('.booking-form .form-pair'); return meta && staff && Boolean(meta.compareDocumentPosition(staff) & Node.DOCUMENT_POSITION_FOLLOWING); })()");
  await requireDom(cdp, name + " summary prioritizes visit data", "document.querySelector('.ticket-top h2')?.textContent.trim() === 'Ваш визит' && !document.querySelector('.booking-summary .ticket-mark')");

  // Force a genuinely empty synthetic Sunday. An empty result must not be
  // mistaken for missing prerequisites or a transport failure.
  const previousBookingDate = await evaluate(cdp, "document.querySelector('.booking-form input[type=date]')?.value");
  const closedSunday = await evaluate(cdp, `(() => {
    const raw = document.querySelector('.booking-form input[type=date]').value;
    const [y, m, d] = raw.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + ((7 - date.getDay()) % 7 || 7));
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')].join('-');
  })()`);
  await fill(cdp, ".booking-form input[type=date]", closedSunday, "change");
  await requireDom(cdp, name + " guest no-slots message", "document.querySelector('.slot-feedback-empty strong')?.textContent.includes('нет свободного времени') && !document.querySelector('.slot-feedback-empty')?.textContent.includes('настройте график')");
  await requireDom(cdp, name + " no-slots blocks confirmation", "document.querySelector('.booking-form .book-submit')?.disabled && !document.querySelector('.booking-form .slot-grid button')");
  await checkWidth(cdp, name + " empty availability");
  await checkLabeledControls(cdp, name + " empty availability");
  await captureEvidence(cdp, name, "18-sunday-unavailable");

  const followingMonday = new Date(closedSunday + "T12:00:00Z");
  followingMonday.setUTCDate(followingMonday.getUTCDate() + 1);
  const nextDate = followingMonday.toISOString().slice(0, 10);
  await click(cdp, ".slot-feedback-empty button");
  await requireDom(cdp, name + " next-day lookup recovered", "document.querySelector('.booking-form input[type=date]')?.value === " + JSON.stringify(nextDate) + " && !!document.querySelector('.booking-form .slot-grid button')");
  await requireDom(cdp, name + " no arbitrary auto booking after recovery", "document.querySelector('.booking-form .book-submit')?.disabled && !document.querySelector('.booking-form .slot-grid button[aria-pressed=true]')");
  await checkWidth(cdp, name + " recovered availability");
  await captureEvidence(cdp, name, "19-next-day-recovery");

  // One-shot synthetic fault: only browser-smoke mode can read this flag.
  // Real API mode and ordinary mock sessions never honor it.
  await evaluate(cdp, "sessionStorage.setItem('cookie.frontend-demo.smoke.fail-next-slots', '1')");
  await fill(cdp, ".booking-form input[type=date]", previousBookingDate, "change");
  await requireDom(cdp, name + " inline failed slot lookup", "document.querySelector('.slot-feedback-error[role=alert] strong')?.textContent.includes('Не удалось проверить время')");
  await requireDom(cdp, name + " error is distinct from no availability", "!document.querySelector('.slot-feedback-empty') && !document.querySelector('.booking-form .slot-grid button')");
  await requireDom(cdp, name + " previous time cleared on error", "document.querySelector('.booking-form .book-submit')?.disabled && !document.querySelector('.slot-feedback-error')?.textContent.includes('SYNTHETIC_SMOKE')");
  await requireDom(cdp, name + " one-shot failure consumed", "sessionStorage.getItem('cookie.frontend-demo.smoke.fail-next-slots') === null");
  await checkWidth(cdp, name + " failed lookup");
  await checkLabeledControls(cdp, name + " failed lookup");
  await captureEvidence(cdp, name, "20-slot-lookup-error");

  await click(cdp, ".slot-feedback-error button");
  await requireDom(cdp, name + " retry restores synthetic slots", "!!document.querySelector('.booking-form .slot-grid button') && !document.querySelector('.slot-feedback-error')");
  await requireDom(cdp, name + " retry preserves selection without choosing a slot", "document.querySelector('.booking-form input[type=date]')?.value === " + JSON.stringify(previousBookingDate) + " && document.querySelector('.booking-form .book-submit')?.disabled && !document.querySelector('.booking-form .slot-grid button[aria-pressed=true]')");
  await checkWidth(cdp, name + " retried lookup");
  await checkLabeledControls(cdp, name + " retried lookup");
  await captureEvidence(cdp, name, "21-retry-restored");
  await captureEvidence(cdp, name, "02-booking");
  await click(cdp, ".booking-form .slot-grid button");
  await requireDom(cdp, name + " selected slot", "document.querySelector('.booking-form .slot-grid button[aria-pressed=true]')");
  await submitValidForm(cdp, ".booking-form");
  await requireDom(cdp, name + " synthetic success", "document.querySelector('.success-screen')?.textContent.includes('не подтверждена backend')");
  await requireDom(cdp, name + " extracted confirmation", "document.querySelector('.booking-confirmation .confirmation-receipt')");
  await requireDom(cdp, name + " no customer-to-owner calendar CTA", "!Array.from(document.querySelectorAll('.booking-confirmation button')).some(item => item.textContent.includes('календар'))");
  await requireDom(cdp, name + " explicit customer next action", "document.querySelector('.confirmation-primary')?.textContent.includes('Ещё одна демо-запись')");
  await requireDom(cdp, name + " salon identity on receipt", "document.querySelector('.confirmation-edition')?.textContent.includes('Студия Smoke')");
  await captureEvidence(cdp, name, "03-confirmation");

  // The owner calendar is reached only by leaving the clearly marked synthetic demo shell.
  await click(cdp, ".public-demo-back");
  await click(cdp, ".nav-links button:nth-child(2)");
  if (width <= 900) await click(cdp, ".segmented button:nth-child(2)");
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
  await requireDom(cdp, name + " dialog reschedule action", "document.activeElement?.classList.contains('calendar-demo-reschedule')");
  await keyboard(cdp, "Tab", 9);
  await requireDom(cdp, name + " dialog cancel action", "document.activeElement?.classList.contains('calendar-demo-cancel')");
  await keyboard(cdp, "Tab", 9);
  await requireDom(cdp, name + " dialog last action", "document.activeElement?.classList.contains('btn-wide')");
  await keyboard(cdp, "Tab", 9);
  await requireDom(cdp, name + " dialog Tab wrapped", "document.activeElement?.classList.contains('close-button')");
  await keyboard(cdp, "Tab", 9, 8);
  await requireDom(cdp, name + " dialog Shift+Tab wrapped", "document.activeElement?.classList.contains('btn-wide')");
  await keyboard(cdp, "Escape", 27);
  await poll(name + " Escape closes modal", async () =>
    !(await evaluate(cdp, "Boolean(document.querySelector('[role=dialog]'))")));
  await requireDom(cdp, name + " dialog focus restored", "document.activeElement?.classList.contains('calendar-event')");

  // A real interactive owner workflow in mock mode: reschedule the existing
  // session-local record; never claim an actual HTTP reservation.
  await click(cdp, ".calendar-event");
  await click(cdp, ".calendar-demo-reschedule");
  await requireDom(cdp, name + " move UI", "document.querySelector('.calendar-move-form select')");
  await requireDom(cdp, name + " move fixture options", "document.querySelector('.calendar-move-form select option[value=\"12:00\"]')");
  await checkWidth(cdp, name + " move UI");
  await fill(cdp, ".calendar-move-form select", "12:00", "change");
  await click(cdp, ".calendar-move-save");
  await requireDom(cdp, name + " rescheduled event", "document.querySelector('.calendar-event .calendar-event-time')?.textContent.includes('12:00')");
  await requireDom(cdp, name + " rescheduled storage", "JSON.parse(sessionStorage.getItem('cookie.frontend-demo.v1')).bookings[0].time === '12:00'");

  await click(cdp, ".segmented button:first-child");
  await requireDom(cdp, name + " calendar day", "document.querySelector('.day-timeline .timeline-entry')");
  await requireDom(cdp, name + " staff-time day board", "document.querySelector('.calendar-day-board .resource-visit')");

  await captureEvidence(cdp, name, "06-calendar-day");
  // Two-step demo cancellation releases the fixture event and leaves audit-like
  // session history visible. This is deliberately not a backend operation.
  await click(cdp, width <= 900 ? ".calendar-day-list .timeline-entry" : ".calendar-day-board .resource-visit");
  await click(cdp, ".calendar-demo-cancel");
  await requireDom(cdp, name + " cancellation confirm", "document.querySelector('.calendar-cancel-confirm')?.textContent.includes('Отменить')");
  await click(cdp, ".calendar-confirm-cancel");
  await requireDom(cdp, name + " cancelled history", "document.querySelector('.calendar-cancelled-history .calendar-cancelled-entry')?.textContent.includes('Отменена')");
  await requireDom(cdp, name + " active visit cleared", "document.querySelectorAll('.calendar-event, .calendar-day-board .resource-visit').length === 0");
  await requireDom(cdp, name + " persisted cancellation", "JSON.parse(sessionStorage.getItem('cookie.frontend-demo.v1')).bookings[0].status === 'demo-cancelled'");
  await checkWidth(cdp, name + " cancellation history");
  await cdp.send("Page.reload", { ignoreCache: true });
  await requireDom(cdp, name + " restored synthetic booking", "(() => { const saved = sessionStorage.getItem('cookie.frontend-demo.v1'); return !!saved && JSON.parse(saved).bookings?.length === 1; })()");
  if (width <= 680) {
    await requireDom(cdp, name + " mobile navigation", "document.querySelector('.mobile-nav button:nth-child(4)') && getComputedStyle(document.querySelector('.mobile-nav')).display === 'grid'");
    await click(cdp, ".mobile-nav button:nth-child(4)");
    await requireDom(cdp, name + " secondary mobile navigation", "document.querySelector('.mobile-more-panel button')");
    await click(cdp, ".mobile-nav button:nth-child(4)");
  }
  await checkWidth(cdp, name + " restored home");
  await checkLabeledControls(cdp, name + " workspace");
  await captureEvidence(cdp, name, "07-workspace");

  // Appearance edits stay synthetic, persist in this tab, and theme the same public UI.
  await click(cdp, ".nav-links button:nth-child(7)");
  await requireDom(cdp, name + " appearance editor", "document.querySelector('.section-head h1')?.textContent === 'Оформление'");
  await checkWidth(cdp, name + " appearance");
  await checkLabeledControls(cdp, name + " appearance");
  await click(cdp, ".appearance-presets button:nth-child(2)");
  await fill(cdp, ".appearance-introduction-field textarea", "Добро пожаловать на запись", "input");
  await requireDom(cdp, name + " live appearance preview", "getComputedStyle(document.querySelector('.appearance-preview-hero')).backgroundColor === 'rgb(36, 72, 59)'");
  await requireDom(cdp, name + " unsaved theme identified", "document.querySelector('.appearance-preview-badge')?.textContent.includes('Не сохранено') && document.querySelector('.appearance-open')?.disabled && !document.querySelector('.appearance-save')?.disabled");
  await captureEvidence(cdp, name, "14-appearance-preview");
  await submitValidForm(cdp, ".appearance-editor form");
  await requireDom(cdp, name + " persisted synthetic appearance", "JSON.parse(sessionStorage.getItem('cookie.frontend-demo.v1')).appearance?.theme === 'forest'");
  await requireDom(cdp, name + " saved theme identified", "document.querySelector('.appearance-preview-badge')?.textContent.includes('Сохранено') && !document.querySelector('.appearance-open')?.disabled && document.querySelector('.appearance-save')?.disabled");
  await click(cdp, ".appearance-open");
  await requireDom(cdp, name + " themed booking", "document.querySelector('.public-shell.salonThemeForest .booking-hero-copy p')?.textContent.includes('Добро пожаловать на запись')");
  await requireDom(cdp, name + " theme applied to public hero", "getComputedStyle(document.querySelector('.public-content .booking-hero')).backgroundColor === 'rgb(36, 72, 59)'");
  await requireDom(cdp, name + " themed booking retains upfront price", "document.querySelector('.booking-service-meta .booking-service-price')?.textContent.replaceAll(String.fromCharCode(160), ' ').includes('1 500 ₽')");
  await captureEvidence(cdp, name, "15-themed-booking");
  await click(cdp, ".booking-form .slot-grid button");
  await submitValidForm(cdp, ".booking-form");
  await requireDom(cdp, name + " themed salon receipt", "document.querySelector('.confirmation-edition')?.textContent.includes('Студия Smoke') && getComputedStyle(document.querySelector('.confirmation-top')).backgroundColor === 'rgb(49, 86, 70)'");
  await requireDom(cdp, name + " no themed calendar action", "!Array.from(document.querySelectorAll('.booking-confirmation button')).some(item => item.textContent.includes('календар'))");
  await captureEvidence(cdp, name, "17-themed-confirmation");
  await click(cdp, ".public-demo-back");
  await requireDom(cdp, name + " returned to demo workspace", "document.querySelector('.section-head h1')?.textContent !== 'Оформление'");

  // Regression: clay background is lighter, so the editorial secondary copy
  // must still achieve WCAG AA normal-text contrast in actual computed styles.
  await click(cdp, ".nav-links button:nth-child(7)");
  await requireDom(cdp, name + " appearance editor reopened", "document.querySelector('.section-head h1')?.textContent === 'Оформление'");
  await click(cdp, ".appearance-presets button:nth-child(4)");
  await submitValidForm(cdp, ".appearance-editor form");
  await requireDom(cdp, name + " clay theme stored", "JSON.parse(sessionStorage.getItem('cookie.frontend-demo.v1')).appearance?.theme === 'clay'");
  await click(cdp, ".appearance-open");
  await requireDom(cdp, name + " clay theme rendered on booking", "!!document.querySelector('.public-shell.salonThemeClay .booking-hero')");
  const clayContrast = await evaluate(cdp, `(() => {
    const toRgb = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number);
    const luminance = (rgb) => {
      const channels = rgb.map((value) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (fg, bg) => {
      const a = luminance(toRgb(fg));
      const b = luminance(toRgb(bg));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return [
      [".booking-hero-studio > span", ".booking-hero"],
      [".ticket-topline", ".ticket-top"],
      [".ticket-top p", ".ticket-top"],
    ].map(([foreground, background]) => ({
      foreground, background,
      contrast: ratio(
        getComputedStyle(document.querySelector(foreground)).color,
        getComputedStyle(document.querySelector(background)).backgroundColor,
      ),
    }));
  })()`);
  for (const target of clayContrast) {
    assert.ok(
      target.contrast >= 4.5,
      name + ": clay theme " + target.foreground + " must meet 4.5:1, got " +
        target.contrast.toFixed(2) + ":1",
    );
  }
  await checkWidth(cdp, name + " clay contrast booking");
  await captureEvidence(cdp, name, "22-clay-contrast");
  await click(cdp, ".public-demo-back");
  await requireDom(cdp, name + " clay return to workspace", "document.querySelector('.section-head h1')?.textContent !== 'Оформление'");
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

  console.log("PASS browser viewport " + name + ": onboarding → booking → move → cancel → history → appearance → themed booking → reset");
}

async function main() {
  assert.ok(existsSync(join(distDir, "index.html")), "Run pnpm --filter @cookie/web build:fixture before fixture smoke");
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
      captures: ["onboarding", "booking", "confirmation", "calendar-week", "detail", "calendar-day", "workspace", "services", "staff", "schedule", "locations", "appearance-preview", "themed-booking", "themed-confirmation", "unavailable-booking", "sunday-unavailable", "next-day-recovery", "slot-lookup-error", "retry-restored", "error-preview", "forbidden-preview", "clay-contrast"],
      checks: ["end-to-end demo UI", "horizontal overflow", "accessible controls", "dialog keyboard", "simulated embedded safe-area CSS", "no external requests", "zero uncaught page exceptions"],
      externalRequests: externalUrls.length,
    }, null, 2) + "\n");
    console.log("PASS evidence: 22 captures per viewport and manifest; external requests =", externalUrls.length);
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

// Share DOM/CDP assertions without running the synthetic suite on import.
export {
  browserBinary, freePort, poll, getLocal, createClient, evaluate,
  requireDom, click, fill, submitValidForm, checkWidth, checkLabeledControls,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Cookie browser smoke failed:", error);
    process.exitCode = 1;
  });
}
