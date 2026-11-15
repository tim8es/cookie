import type { Pool } from "pg";

import { readOutboxQueueMetrics, type OutboxQueueMetrics } from "./worker.js";

/**
 * Explicit operator-owned alert thresholds; no hard-coded product SLA.
 * A value must be GREATER than a threshold to breach it, making zero a
 * suitable policy for alerting on the first dead event or expired lease.
 */
export interface OutboxAlertLimits {
  readonly warning: number;
  readonly critical: number;
}

export interface OutboxHealthPolicy {
  readonly due: OutboxAlertLimits;
  readonly oldestDueSeconds: OutboxAlertLimits;
  readonly expiredLeases: OutboxAlertLimits;
  readonly dead: OutboxAlertLimits;
}

export type OutboxHealthCode =
  | "DUE_BACKLOG"
  | "OLDEST_DUE"
  | "EXPIRED_LEASES"
  | "DEAD_LETTERS"
  | "METRICS_UNAVAILABLE";

export type OutboxHealthSeverity = "warning" | "critical";
export type OutboxHealthStatus =
  | "healthy"
  | "degraded"
  | "critical"
  | "unavailable";

export interface OutboxHealthFinding {
  readonly code: OutboxHealthCode;
  readonly severity: OutboxHealthSeverity;
}

export type OutboxHealthSnapshot =
  | {
      readonly status: "healthy" | "degraded" | "critical";
      readonly findings: readonly OutboxHealthFinding[];
      /**
       * Global queue-level aggregates only; never contains tenant IDs, event
       * identifiers, message text, payloads or error strings.
       * Must remain a trusted operational interface, not a public endpoint.
       */
      readonly metrics: Readonly<OutboxQueueMetrics>;
    }
  | {
      readonly status: "unavailable";
      readonly findings: readonly OutboxHealthFinding[];
      readonly metrics?: never;
    };

function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validatePair(
  value: OutboxAlertLimits | undefined,
  field: string,
): void {
  if (
    !value ||
    !validLimit(value.warning) ||
    !validLimit(value.critical) ||
    value.critical < value.warning
  ) {
    throw new Error(`Invalid outbox health thresholds: ${field}`);
  }
}

/** Caller must supply an explicit, reviewed policy. No hidden alert SLA. */
export function validateOutboxHealthPolicy(policy: OutboxHealthPolicy): void {
  if (!policy) throw new Error("Outbox health policy required");
  validatePair(policy.due, "due");
  validatePair(policy.oldestDueSeconds, "oldestDueSeconds");
  validatePair(policy.expiredLeases, "expiredLeases");
  validatePair(policy.dead, "dead");
}

function validateMetrics(metrics: OutboxQueueMetrics): void {
  if (
    !metrics ||
    !validLimit(metrics.pending) ||
    !validLimit(metrics.due) ||
    !validLimit(metrics.leased) ||
    !validLimit(metrics.expiredLeases) ||
    !validLimit(metrics.delivered) ||
    !validLimit(metrics.dead) ||
    typeof metrics.oldestDueSeconds !== "number" ||
    !Number.isFinite(metrics.oldestDueSeconds) ||
    metrics.oldestDueSeconds < 0 ||
    metrics.due > metrics.pending ||
    metrics.expiredLeases > metrics.leased
  ) {
    throw new Error("Invalid outbox health aggregate metrics");
  }
}

function classify(
  current: number,
  thresholds: OutboxAlertLimits,
): OutboxHealthSeverity | undefined {
  if (current > thresholds.critical) return "critical";
  if (current > thresholds.warning) return "warning";
  return undefined;
}

/**
 * Pure deterministic health evaluator. It never reads event payloads,
 * accesses secrets, logs, sends alerts or mutates queue state.
 *
 * A "dead" event remains counted until an operator replays/purges it, so
 * alert consumers should deduplicate unchanged findings across samples.
 */
export function evaluateOutboxHealth(
  metrics: OutboxQueueMetrics,
  policy: OutboxHealthPolicy,
): OutboxHealthSnapshot {
  validateOutboxHealthPolicy(policy);
  validateMetrics(metrics);

  const findings: OutboxHealthFinding[] = [];
  const checks: readonly [OutboxHealthCode, number, OutboxAlertLimits][] = [
    ["DUE_BACKLOG", metrics.due, policy.due],
    ["OLDEST_DUE", metrics.oldestDueSeconds, policy.oldestDueSeconds],
    ["EXPIRED_LEASES", metrics.expiredLeases, policy.expiredLeases],
    ["DEAD_LETTERS", metrics.dead, policy.dead],
  ];
  for (const [code, current, threshold] of checks) {
    const severity = classify(current, threshold);
    if (severity) findings.push({ code, severity });
  }

  const status: OutboxHealthSnapshot["status"] = findings.some(
    (finding) => finding.severity === "critical",
  )
    ? "critical"
    : findings.length
      ? "degraded"
      : "healthy";

  return { status, findings, metrics: { ...metrics } };
}

/**
 * One-shot trusted operational sampler. An unexpected database/driver error
 * is reported with a fixed reason code only; never emit raw error strings.
 * Invalid policy and internally inconsistent returned metrics still fail
 * loudly and must not masquerade as a healthy queue.
 *
 * No timers, network/HTTP exposure, alerting provider or background worker.
 */
export async function sampleOutboxHealth(
  pool: Pool,
  policy: OutboxHealthPolicy,
): Promise<OutboxHealthSnapshot> {
  validateOutboxHealthPolicy(policy);

  let metrics: OutboxQueueMetrics;
  try {
    metrics = await readOutboxQueueMetrics(pool);
  } catch {
    return {
      status: "unavailable",
      findings: [{ code: "METRICS_UNAVAILABLE", severity: "critical" }],
    };
  }
  return evaluateOutboxHealth(metrics, policy);
}
