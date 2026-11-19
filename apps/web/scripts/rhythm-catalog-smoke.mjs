// Isolated, compiled Svelte catalog. Reuse the existing Chromium/CDP harness.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { browserBinary, freePort, poll, getLocal, createClient, evaluate, requireDom, click, fill, checkWidth, checkLabeledControls } from "./browser-smoke.mjs";

const webDir = fileURLToPath(new URL("../", import.meta.url));
const dist = join(webDir, ".tmp/rhythm-ui-kit-dist");
const evidence = join(webDir, "artifacts/rhythm-ui-kit");
const themes = ["workspace", "studio", "linen", "graphite", "sage"];
const widths = [[320, 568], [375, 812], [768, 960], [1280, 800]];
const sections = ["Контролы", "Каталог", "Записи", "Редакторы", "Состояния"];

async function button(cdp, name) {
  const ok = await evaluate(cdp, "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === " + JSON.stringify(name) + "); if (!b || b.disabled) return false; b.focus(); b.click(); return true; })()");
  assert.equal(ok, true, "Missing enabled button: " + name);
}

async function expectText(cdp, value) {
  await requireDom(cdp, value, "document.body.textContent.includes(" + JSON.stringify(value) + ")");
}

async function verifyChoice(cdp) {
  const result = await evaluate(cdp, `(() => {
    const row = document.querySelector('[data-component=ChoiceRow][aria-pressed=false]:not(:disabled)');
    const scope = row?.closest('.rhythm-scope');
    return row && scope && getComputedStyle(row).backgroundColor === getComputedStyle(scope).backgroundColor;
  })()`);
  assert.equal(result, true, "Unselected choice must inherit the booking canvas");
}

async function capture(cdp, stem) {
  await evaluate(cdp, "window.scrollTo(0,0)");
  await pause(160);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidence, stem + ".png"), Buffer.from(shot.data, "base64"));
}

async function main() {
  assert.ok(existsSync(join(dist, "ui-kit/index.html")), "Build the isolated UI kit first");
  rmSync(evidence, { recursive: true, force: true });
  mkdirSync(evidence, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), "kuki-rhythm-smoke-"));
  const fixture = join(temp, "sample.png");
  writeFileSync(fixture, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1e0AAAAASUVORK5CYII=", "base64"));
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const relative = pathname === "/ui-kit/" ? "ui-kit/index.html" : pathname.slice(1);
    if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.split("/").includes("..")) {
      response.writeHead(403).end();
      return;
    }
    const file = join(dist, relative);
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const type = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html" }[extname(file)] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    createReadStream(file).pipe(response);
  });
  let chrome;
  let cdp;
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const origin = "http://127.0.0.1:" + server.address().port + "/ui-kit/";
    const port = await freePort();
    chrome = spawn(browserBinary(), [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
      "--user-data-dir=" + join(temp, "chrome"), "about:blank",
    ], { stdio: "ignore" });
    const target = await poll("catalog Chrome target", async () => {
      const reply = await getLocal("http://127.0.0.1:" + port + "/json/list");
      return JSON.parse(reply.text).find((p) => p.type === "page" && p.webSocketDebuggerUrl);
    }, 20000);
    cdp = createClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    const errors = [];
    const external = [];
    cdp.onEvent("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.text));
    cdp.onEvent("Network.requestWillBeSent", (p) => {
      const url = p.request.url;
      if (/^https?:/.test(url) && new URL(url).hostname !== "127.0.0.1") external.push(url);
    });
    let states = 0;
    for (const [width, height] of widths) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, mobile: width < 600, deviceScaleFactor: 1 });
      await cdp.send("Page.navigate", { url: origin });
      await requireDom(cdp, "catalog mounted", "document.querySelector('#theme')");
      for (const theme of themes) {
        await fill(cdp, "#theme", theme, "change");
        await requireDom(cdp, "theme selected", "document.querySelector('.rhythm-scope')?.dataset.rhythmTheme === " + JSON.stringify(theme));
        for (const section of sections) {
          await button(cdp, section);
          await requireDom(cdp, "section selected", "[...document.querySelectorAll('.rhythm-segment button[aria-pressed=true]')].some(b => b.textContent.trim() === " + JSON.stringify(section) + ")");
          await checkWidth(cdp, width + "/" + theme + "/" + section);
          await checkLabeledControls(cdp, section);
          if (section === "Каталог") {
            await verifyChoice(cdp);
            await click(cdp, '[data-component=ChoiceRow]:nth-child(2)');
            await requireDom(cdp, "choice selection", "document.querySelectorAll('[data-component=ChoiceRow]')[1].getAttribute('aria-pressed') === 'true'");
            await verifyChoice(cdp);
          }
          if (section === "Контролы") {
            await button(cdp, "Переключить ошибку");
            await requireDom(cdp, "error state", "document.querySelector('#catalog-name').getAttribute('aria-invalid') === 'true'");
            await button(cdp, "Переключить ошибку");
          }
          if (section === "Записи") {
            await button(cdp, "Открыть");
            await requireDom(cdp, "ticket", "document.querySelector('[data-component=BookingTicket]')");
            await button(cdp, "Открыть");
          }
          if (section === "Редакторы") {
            await click(cdp, '[data-component=CheckGroup] label:nth-of-type(2) input');
            assert.equal(await evaluate(cdp, "document.querySelector('[data-component=CheckGroup] label:nth-of-type(2) input').checked"), true);
            await button(cdp, "Сохранить");
            await expectText(cdp, "Значение сохранено");
            await button(cdp, "Переключить состояние сохранения");
            assert.equal(await evaluate(cdp, "document.querySelector('form button[type=submit]').disabled"), true);
            await button(cdp, "Переключить состояние сохранения");
            await click(cdp, '[data-component=CheckGroup] label:nth-of-type(2) input');
          }
          if (section === "Состояния") {
            await button(cdp, "Повторить");
            await expectText(cdp, "Повторная попытка");
          }
          if (width === 375 || width === 1280) await capture(cdp, [width, theme, sections.indexOf(section)].join("-"));
          states++;
        }
        await button(cdp, "Сбросить примеры");
      }
      await button(cdp, "Редакторы");
      await cdp.send("DOM.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#catalog-image" });
      assert.ok(nodeId);
      await cdp.send("DOM.setFileInputFiles", { nodeId, files: [fixture] });
      await requireDom(cdp, "local preview", "document.querySelector('[data-component=ImageAssetField] img')?.naturalWidth > 0");
      await button(cdp, "Удалить изображение");
      await requireDom(cdp, "image removed", "!document.querySelector('[data-component=ImageAssetField] img')");
      await button(cdp, "Контролы");
      await evaluate(cdp, "document.querySelector('#catalog-name').focus()");
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      assert.equal(await evaluate(cdp, "document.activeElement?.textContent.trim()"), "Переключить ошибку");
    }
    assert.deepEqual(errors, [], "Uncaught catalog errors");
    assert.deepEqual(external, [], "Unexpected external network requests");
    writeFileSync(join(evidence, "manifest.json"), JSON.stringify({ states, themes, widths, captures: 50, externalRequests: external.length }, null, 2));
    console.log("PASS Rhythm catalog: " + states + " states, file preview/remove, keyboard, no external requests");
  } finally {
    cdp?.close();
    chrome?.kill("SIGTERM");
    server.close();
    await pause(300);
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Rhythm catalog smoke failed:", error);
  process.exitCode = 1;
});
