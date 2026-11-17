// Recovery is limited to an exact project previously allocated by a worker
// owned by this manager. Never discover and delete projects by prefix.
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { isLocalStagingProject, resolveLocalStagingMode, localDemoFetch } from "./local-staging-mode.mjs";

const mode = resolveLocalStagingMode(["demo"]);
const root = fileURLToPath(new URL("..", import.meta.url));
const compose = fileURLToPath(new URL("../docker-compose.manual.yml", import.meta.url));

export function portRefused(origin) {
  localDemoFetch(origin);
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(origin).port) });
    let finished = false;
    const done = value => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(false));
    socket.once("error", error => done(error.code === "ECONNREFUSED"));
    socket.setTimeout(1000, () => done(false));
  });
}

export async function recoverPrivateDemoProject(project, origin, {
  probe = portRefused, run = spawnSync,
} = {}) {
  if (!isLocalStagingProject(mode, project)) return false;
  localDemoFetch(origin);
  // The IPC-bound API must have stopped. Do not kill arbitrary PIDs or
  // delete a database if the former port still accepts connections.
  if (!await probe(origin)) return false;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(COOKIE_|DATABASE_URL$|PG|NODE_OPTIONS$|COMPOSE_)/i.test(key)));
  // Compose interpolation is required even for down; these are deliberately
  // inert placeholders, not the original database password or port.
  const result = run("docker", ["compose", "-p", project, "-f", compose, "down", "-v"], {
    cwd: root, stdio: "ignore", timeout: 30000,
    env: { ...env, COOKIE_MANUAL_DB_PORT: "5432", COOKIE_MANUAL_DB_PASSWORD: "disposable-recovery-only" },
  });
  return result.status === 0;
}
