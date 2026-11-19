/** Presentation hint only. It never authenticates a user or grants a role. */
export interface WorkspaceHint {
  readonly role: "business" | "customer";
  readonly tenantId: string;
}

const KEY = "kukiWorkspace";
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

export function readWorkspaceHint(history: History): WorkspaceHint | null {
  try {
    return parseWorkspaceHint(history.state?.[KEY]);
  } catch {
    return null;
  }
}

export function writeWorkspaceHint(
  history: History,
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
