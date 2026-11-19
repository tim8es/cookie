// A notification carries no identity, role, credential or session identifier.
const CHANNEL = "kuki-browser-session-v1";

export function notifyBrowserSessionChanged(): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage("changed");
    channel.close();
  } catch {
    // Focus and page-resume checks remain available.
  }
}

export function subscribeBrowserSessionChanges(
  win: Window,
  doc: Document,
  check: () => void,
): () => void {
  let channel: BroadcastChannel | undefined;
  const visible = () => {
    if (doc.visibilityState === "visible") check();
  };
  win.addEventListener("focus", check);
  win.addEventListener("pageshow", check);
  doc.addEventListener("visibilitychange", visible);
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "changed") check();
      };
    }
  } catch {
    // Some WebViews do not support BroadcastChannel.
  }
  return () => {
    channel?.close();
    win.removeEventListener("focus", check);
    win.removeEventListener("pageshow", check);
    doc.removeEventListener("visibilitychange", visible);
  };
}
