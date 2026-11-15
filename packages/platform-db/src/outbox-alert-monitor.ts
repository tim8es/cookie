import type {
  OutboxHealthCode,
  OutboxHealthSeverity,
  OutboxHealthSnapshot,
} from "./outbox-health.js";

/** Pure, restart-local state; future durable alert storage is a separate gate. */
export interface OutboxAlertState {
  readonly active: Readonly<Partial<Record<OutboxHealthCode, OutboxHealthSeverity>>>;
}

export type OutboxAlertChangeKind =
  | "raised"
  | "escalated"
  | "deescalated"
  | "resolved";

export interface OutboxAlertTransition {
  readonly kind: OutboxAlertChangeKind;
  readonly code: OutboxHealthCode;
  readonly previousSeverity?: OutboxHealthSeverity;
  readonly severity?: OutboxHealthSeverity;
}

export interface OutboxAlertDecision {
  readonly state: OutboxAlertState;
  /** Stable reason codes and severities only, no counters or customer data. */
  readonly transitions: readonly OutboxAlertTransition[];
}

const knownCodes: readonly OutboxHealthCode[] = [
  "DUE_BACKLOG",
  "OLDEST_DUE",
  "EXPIRED_LEASES",
  "DEAD_LETTERS",
  "METRICS_UNAVAILABLE",
];

export function emptyOutboxAlertState(): OutboxAlertState {
  return { active: {} };
}

/**
 * Invalid/contradictory health input MUST NOT be interpreted as recovery.
 * Health samples normally come from evaluateOutboxHealth or sampleOutboxHealth.
 */
function verifySnapshot(snapshot: OutboxHealthSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.findings)) {
    throw new Error("Invalid outbox alert snapshot");
  }
  const codes = new Set<OutboxHealthCode>();
  for (const finding of snapshot.findings) {
    if (
      !finding ||
      !knownCodes.includes(finding.code) ||
      (finding.severity !== "warning" && finding.severity !== "critical") ||
      codes.has(finding.code)
    ) {
      throw new Error("Invalid outbox alert snapshot");
    }
    codes.add(finding.code);
  }
  if (snapshot.status === "unavailable") {
    if (
      snapshot.metrics !== undefined ||
      snapshot.findings.length !== 1 ||
      snapshot.findings[0]?.code !== "METRICS_UNAVAILABLE" ||
      snapshot.findings[0]?.severity !== "critical"
    ) {
      throw new Error("Invalid outbox alert snapshot");
    }
    return;
  }
  if (
    snapshot.status !== "healthy" &&
    snapshot.status !== "degraded" &&
    snapshot.status !== "critical"
  ) {
    throw new Error("Invalid outbox alert snapshot");
  }
  if (!snapshot.metrics || codes.has("METRICS_UNAVAILABLE")) {
    throw new Error("Invalid outbox alert snapshot");
  }
  const expected = snapshot.findings.some(
    (finding) => finding.severity === "critical",
  )
    ? "critical"
    : snapshot.findings.length
      ? "degraded"
      : "healthy";
  if (snapshot.status !== expected) {
    throw new Error("Invalid outbox alert snapshot");
  }
}

/**
 * Dedupe unchanged findings, emit severity changes once and signal recovery.
 * A read outage is NOT proof that the previous backlog/dead letters cleared.
 * The previous queue findings are retained during an unavailable sample;
 * only METRICS_UNAVAILABLE is added until a valid DB sample returns.
 */
export function reconcileOutboxAlerts(
  previous: OutboxAlertState,
  snapshot: OutboxHealthSnapshot,
): OutboxAlertDecision {
  verifySnapshot(snapshot);
  if (!previous || !previous.active) {
    throw new Error("Invalid outbox alert state");
  }

  const next: Partial<Record<OutboxHealthCode, OutboxHealthSeverity>> = {
    ...previous.active,
  };
  const current = new Map(
    snapshot.findings.map((finding) => [finding.code, finding.severity]),
  );
  const transitions: OutboxAlertTransition[] = [];

  for (const code of knownCodes) {
    if (snapshot.status === "unavailable" && code !== "METRICS_UNAVAILABLE") {
      continue;
    }

    const before = next[code];
    const after = current.get(code);
    if (before === after) continue;
    if (after === undefined) {
      delete next[code];
      if (before) {
        transitions.push({ kind: "resolved", code, previousSeverity: before });
      }
      continue;
    }
    next[code] = after;
    if (!before) {
      transitions.push({ kind: "raised", code, severity: after });
    } else {
      transitions.push({
        kind: after === "critical" ? "escalated" : "deescalated",
        code,
        previousSeverity: before,
        severity: after,
      });
    }
  }

  return { state: { active: next }, transitions };
}

export interface OutboxAlertMonitorOptions {
  readonly signal: AbortSignal;
  /** Trusted one-shot sampler; may read PostgreSQL, not external providers. */
  readonly sample: () => Promise<OutboxHealthSnapshot>;
  /** Technical polling interval, not an advertised service SLO. */
  readonly intervalMs?: number;
  /** Stop instead of issuing overlapping polls after a stalled sample. */
  readonly sampleTimeoutMs?: number;
  /** Circuit breaker for repeated database unavailability. */
  readonly maxConsecutiveUnavailable?: number;
  /** Non-throwing, trusted observer; receives codes only. */
  readonly onTransition?: (change: OutboxAlertTransition) => void;
  readonly onSample?: (status: OutboxHealthSnapshot["status"]) => void;
}

function validInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 10 && value <= 60_000;
}

function safeCallback<T>(
  callback: ((value: T) => void) | undefined,
  value: T,
): void {
  try {
    callback?.(value);
  } catch {
    // A broken observer must not alter alert state or stop the monitor.
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", complete);
      resolve();
    };
    const timer = setTimeout(complete, ms);
    signal.addEventListener("abort", complete, { once: true });
    if (signal.aborted) complete();
  });
}

/**
 * A sample timeout ends the monitor rather than starting another SQL query.
 * Promise cancellation does NOT terminate the underlying DB operation;
 * production Pool configuration must still enforce PostgreSQL query_timeout.
 */
function boundedSample(
  sample: OutboxAlertMonitorOptions["sample"],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OutboxHealthSnapshot | null> {
  if (signal.aborted) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      value: OutboxHealthSnapshot | null,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void => finish(null);
    const timer = setTimeout(
      () => finish(null, new Error("Outbox health sampling stopped")),
      timeoutMs,
    );

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(sample)
      .then(
        (sampled) => finish(sampled),
        () => finish(null, new Error("Outbox health sampling stopped")),
      );
  });
}

/**
 * Explicitly invoked supervisor: no timers or network side effects on import.
 * Strict single-flight sampling, abortable delay, bounded timeout and DB
 * outage circuit breaker. Never exposes raw sampling exceptions or metrics
 * through its callbacks.
 */
export async function superviseOutboxHealth(
  options: OutboxAlertMonitorOptions,
): Promise<OutboxAlertState> {
  const intervalMs = options?.intervalMs ?? 1_000;
  const sampleTimeoutMs = options?.sampleTimeoutMs ?? 5_000;
  const maxUnavailable = options?.maxConsecutiveUnavailable ?? 5;
  if (
    !options?.signal ||
    typeof options.sample !== "function" ||
    !validInterval(intervalMs) ||
    !validInterval(sampleTimeoutMs) ||
    !Number.isSafeInteger(maxUnavailable) ||
    maxUnavailable < 1 ||
    maxUnavailable > 20
  ) {
    throw new Error("Invalid outbox health monitor configuration");
  }

  let state = emptyOutboxAlertState();
  let consecutiveUnavailable = 0;

  while (!options.signal.aborted) {
    const sample = await boundedSample(
      options.sample,
      options.signal,
      sampleTimeoutMs,
    );
    if (sample === null || options.signal.aborted) break;
    const decision = reconcileOutboxAlerts(state, sample);
    state = decision.state;
    for (const change of decision.transitions) {
      safeCallback(options.onTransition, change);
    }
    safeCallback(options.onSample, sample.status);
    consecutiveUnavailable =
      sample.status === "unavailable" ? consecutiveUnavailable + 1 : 0;
    if (consecutiveUnavailable >= maxUnavailable) {
      throw new Error("Outbox health monitor stopped after repeated unavailability");
    }
    if (!options.signal.aborted) {
      await abortableDelay(intervalMs, options.signal);
    }
  }
  return state;
}
