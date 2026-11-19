/** Serialize explicit global login and cookie restoration across this origin.
 * Hold the lock through the provider request, Set-Cookie and readback.
 * No Web Locks: the caller may use a tab-only credential, never bind/restore.
 * A rejected lock request is not permission to retry without the lock.
 */
const LOCK = "kuki-browser-login-v1";

type Browser = { readonly navigator: { readonly locks?: LockManager } };

export async function withBrowserLogin<T>(
  win: Browser,
  work: (canPersist: boolean) => Promise<T>,
): Promise<T> {
  let locks: LockManager | undefined;
  try {
    locks = win.navigator.locks;
  } catch {
    return work(false);
  }
  if (!locks || typeof locks.request !== "function") return work(false);
  return await locks.request(LOCK, { mode: "exclusive" }, () => work(true));
}
