// Infrastructure-only startup retry for the synthetic Chromium CDP verifier.
// Deliberately never retries navigation, HTTP commands, or test assertions.
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

function assertRunning(handle) {
  if (
    handle.startupError ||
    handle.chrome.exitCode !== null ||
    handle.chrome.signalCode !== null
  ) {
    throw new Error(
      "Chromium exited before CDP was ready (exit=" +
        String(handle.chrome.exitCode) +
        ", signal=" +
        String(handle.chrome.signalCode) +
        (handle.startupError ? ", spawn=" + handle.startupError : "") +
        ")",
    );
  }
}

/** Test-only CDP discovery; only bounded stage labels, no target URL or body. */
export async function probeChromiumPage(handle, { readPort, getLocal }) {
  handle.probeCount = (handle.probeCount ?? 0) + 1;
  handle.probeStage = "port-file";
  const contents = readPort(handle.dir);
  if (contents === null) return null;
  handle.probeStage = "invalid-port";
  const firstLine = contents.split(/\\r?\\n/)[0];
  if (!/^\\d{1,5}$/.test(firstLine)) return null;
  const port = Number(firstLine);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  handle.probeStage = "http-transport";
  const result = await getLocal("http://127.0.0.1:" + port + "/json/list");
  if (result.code !== 200) {
    handle.probeStage = "http-status-" + String(result.code);
    return null;
  }
  handle.probeStage = "invalid-target-list";
  let targets;
  try {
    targets = JSON.parse(result.body);
  } catch {
    // JSON.parse errors can include response fragments. Never log target data.
    throw new SyntaxError("Invalid CDP target list JSON");
  }
  if (!Array.isArray(targets)) return null;
  handle.probeStage = "no-page-target";
  const target = targets.find((x) => x?.type === "page" && x.webSocketDebuggerUrl);
  if (!target) return null;
  handle.probeStage = "page-target";
  return target;
}

/**
 * Retry only until an independently probed CDP endpoint is ready.
 * The caller owns the returned live browser process and must close it.
 *
 * `startAttempt` must return { chrome, ... } (or another handle with `chrome`).
 * `disposeAttempt` must terminate/reap the process and remove the temporary
 * profile before the next attempt; cleanup failures abort the retry.
 */
export async function startChromiumWithRetry({
  startAttempt,
  probe,
  disposeAttempt,
  attempts = 2,
  startupTimeoutMs = 12000,
  intervalMs = 100,
}) {
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 2 ||
    !Number.isFinite(startupTimeoutMs) ||
    startupTimeoutMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new Error("Invalid bounded Chromium startup retry configuration");
  }

  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const handle = await startAttempt(attempt);
    let lastProbeError;
    try {
      const deadline = performance.now() + startupTimeoutMs;
      while (performance.now() < deadline) {
        assertRunning(handle);
        let ready;
        try {
          ready = await probe(handle);
          lastProbeError = undefined;
        } catch (error) {
          lastProbeError = error;
        }
        // A result from an exited child or an expired attempt is not ready.
        assertRunning(handle);
        if (performance.now() >= deadline) break;
        if (ready) return { handle, ready, attempt, failures: [...failures] };
        await sleep(Math.min(intervalMs, Math.max(0, deadline - performance.now())));
      }
      throw new Error(
        "CDP readiness timed out after " +
          startupTimeoutMs +
          " ms" +
          (lastProbeError ? ": " + lastProbeError.message : ""),
      );
    } catch (error) {
      const diagnostic =
        "startup attempt " +
        attempt +
        "/" +
        attempts +
        ": " +
        error.message +
        "; executable=" + (handle.executable ?? "unknown") +
        "; stage=" + (handle.probeStage ?? "not-probed") +
        "; probes=" + (handle.probeCount ?? 0) +
        "; exit=" + String(handle.chrome.exitCode) +
        "; signal=" + String(handle.chrome.signalCode) +
        (handle.logs?.length
          ? "; chromium stderr=" + handle.logs.join("").slice(-650)
          : "");
      failures.push(diagnostic);
      try {
        await disposeAttempt(handle);
      } catch (cleanupError) {
        throw new Error(
          diagnostic + "; cleanup FAILED: " + cleanupError.message,
        );
      }
    }
  }

  throw new Error("Chromium startup failed: " + failures.join(" | "));
}
