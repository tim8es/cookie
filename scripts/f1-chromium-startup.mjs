// Infrastructure-only startup retry for the synthetic Chromium CDP verifier.
// Deliberately never retries navigation, HTTP commands, or test assertions.
import { setTimeout as sleep } from "node:timers/promises";

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
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
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
        try {
          const ready = await probe(handle);
          if (ready) return { handle, ready, attempt };
        } catch (error) {
          lastProbeError = error;
        }
        await sleep(intervalMs);
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
