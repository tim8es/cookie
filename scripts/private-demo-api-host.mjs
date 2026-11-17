// Run exactly the compiled API in a child with a private parent lifetime.
// A SIGKILL of the launcher closes IPC; the API must not become an orphan.
if (!process.connected || !process.channel || typeof process.send !== "function") {
  throw new Error("Private demo API host requires parent IPC");
}
process.once("disconnect", () => {
  // Emergency-only: PostgreSQL rolls back unfinished transactions when
  // connections close. Normal launcher shutdown still uses API SIGTERM.
  process.exit(1);
});
// The channel must not prevent graceful shutdown of the compiled API.
process.channel.unref();
await import("../dist/apps/api/src/main.js");
