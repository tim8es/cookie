/** Presentation hint only. It never authenticates a user or grants a role. */
export interface WorkspaceHint {
  readonly role: "business" | "customer";
  readonly tenantId: string;
}

type WorkspaceHistory = Pick<History, "state" | "replaceState">;

const KEY = "kukiWorkspace";
const LOGOUT_PENDING = "kukiLogoutPending";
const TAB_LOGOUT_PENDING = "kuki.logout.pending";
type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserTabStorage(): TabStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
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
 * Noncredential tab-local guard, with a history-entry fallback. A failed
 * logout must not automatically restore a live cookie via earlier SPA routes.
 * No token, identity, tenant or other private value is stored here.
 * Neither marker proves server revocation.
 */
export function isLogoutPending(
  history: WorkspaceHistory,
  storage = browserTabStorage(),
): boolean {
  try {
    if (storage?.getItem(TAB_LOGOUT_PENDING) === "1") return true;
  } catch {
    // A disabled storage implementation still has the history fallback.
  }
  try {
    return history.state?.[LOGOUT_PENDING] === true;
  } catch {
    return false;
  }
}

export function writeLogoutPending(
  history: WorkspaceHistory,
  pending: boolean,
  storage = browserTabStorage(),
): void {
  try {
    if (pending) storage?.setItem(TAB_LOGOUT_PENDING, "1");
    else storage?.removeItem(TAB_LOGOUT_PENDING);
  } catch {
    // Persist the history fallback independently.
  }
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
