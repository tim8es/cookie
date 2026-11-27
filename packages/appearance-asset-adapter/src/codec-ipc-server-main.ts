import { startCodecIpcServer } from "./codec-ipc-server.js";

// Dedicated OS-confined worker only. No environment-sourced credentials,
// tenant IDs, TCP listener, app modules or Docker control plane.
const socketPath = process.argv.length === 3 ? process.argv[2] : undefined;
if (!socketPath) {
  process.stderr.write("Private codec socket path required\n");
  process.exitCode = 1;
} else {
  try {
    const server = await startCodecIpcServer({ socketPath });
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => server.close());
    }
  } catch {
    process.stderr.write("Private codec worker unavailable\n");
    process.exitCode = 1;
  }
}
