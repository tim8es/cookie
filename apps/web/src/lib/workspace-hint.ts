/** Presentation hint only. It never authenticates a user or grants a role. */
export interface WorkspaceHint {
  readonly role: "business" | "customer";
  readonly tenantId: string;
}

type WorkspaceHistory = Pick<History, "state" | "replaceState">;

const KEY = "kukiWorkspace";
const LOGOUT_PENDING = "kukiLogoutPending";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWorkspaceHint(value: unknown): WorkspaceHint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hint = value as Record<string, unknown>;
  if (
    Object.keys(hint).length !== 2 ||
    (hint.role !== "business" && hint.role !== "customer") ||
    typeof hint.tenantId !== "string" ||
    !UUID.test(hint.tenantId)
  )
    return null;
  return { role: hint.role, tenantId: hint.tenantId };
}

export function readWorkspaceHint(
  history: WorkspaceHistory,
): WorkspaceHint | null {
  try {
    return parseWorkspaceHint(history.state?.[KEY]);
  } catch {
    return null;
  }
}

export function writeWorkspaceHint(
  history: WorkspaceHistory,
  hint: WorkspaceHint | null,
): void {
  try {
    const previous: unknown = history.state;
    const state =
      previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...previous }
        : {};
    if (hint) Object.assign(state, { [KEY]: hint });
    else Reflect.deleteProperty(state, KEY);
    history.replaceState(state, "");
  } catch {
    // Continuity is optional. The current verified workspace remains usable.
  }
}

/**
 * A noncredential, tab/history-entry-local guard. If logout fails before
 * the server can clear its HttpOnly cookie, never silently restore that
 * cookie on reload of this history entry. It is not a revocation receipt.
 */
export function isLogoutPending(history: WorkspaceHistory): boolean {
  try {
    return history.state?.[LOGOUT_PENDING] === true;
  } catch {
    return false;
  }
}

export function writeLogoutPending(
  history: WorkspaceHistory,
  pending: boolean,
): void {
  try {
    const previous: unknown = history.state;
    const state =
      previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...previous }
        : {};
    if (pending) {
      Object.assign(state, { [LOGOUT_PENDING]: true });
      Reflect.deleteProperty(state, KEY);
    } else Reflect.deleteProperty(state, LOGOUT_PENDING);
    history.replaceState(state, "");
  } catch {
    // Browser history can be unavailable. Never claim server revocation.
  }
}
