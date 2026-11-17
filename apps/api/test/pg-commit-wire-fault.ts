import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";

import { Pool } from "pg";

const ciUrl = "postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci";
type FaultPoint = "before-commit" | "after-commit";

/**
 * One-shot real TCP fault, isolated to the disposable CI database. PostgreSQL
 * cleartext protocol v3 only; no application credentials or traffic logged.
 * Never use this proxy against an operator, staging or production database.
 */
export async function assertCommitWireFailure(
  point: FaultPoint,
  command: (pool: Pool) => Promise<unknown>,
): Promise<void> {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.TEST_DATABASE_URL, ciUrl);
  const sockets = new Set<Socket>();
  let dropped = 0;
  let connections = 0;

  const server = createServer((client) => {
    connections++;
    if (connections !== 1) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: "127.0.0.1", port: 5432 });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
      socket.once("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    let startup = true;
    let frontend: Buffer = Buffer.alloc(0);
    let backend: Buffer = Buffer.alloc(0);

    const drop = (): void => {
      dropped++;
      client.destroy();
      upstream.destroy();
    };

    client.on("data", (chunk: Buffer) => {
      frontend = Buffer.concat([frontend, chunk]);
      // StartupMessage is the only untyped frontend packet. SSL and GSS
      // negotiation are disabled by this test's fixed Pool configuration.
      if (startup) {
        if (frontend.length < 4) return;
        const length = frontend.readUInt32BE(0);
        if (length < 8 || length > 16_384) {
          client.destroy();
          upstream.destroy();
          return;
        }
        if (frontend.length < length) return;
        upstream.write(frontend.subarray(0, length));
        frontend = frontend.subarray(length);
        startup = false;
      }
      while (frontend.length >= 5) {
        const length = frontend.readUInt32BE(1) + 1;
        if (length < 5 || length > 1_048_576) {
          client.destroy();
          upstream.destroy();
          return;
        }
        if (frontend.length < length) return;
        const frame = frontend.subarray(0, length);
        frontend = frontend.subarray(length);
        if (
          point === "before-commit" &&
          frame[0] === 0x51 &&
          frame.subarray(5).toString("utf8") === "COMMIT\0"
        ) {
          // Do not transmit ANY byte of COMMIT to PostgreSQL.
          drop();
          return;
        }
        upstream.write(frame);
      }
    });

    upstream.on("data", (chunk: Buffer) => {
      backend = Buffer.concat([backend, chunk]);
      while (backend.length >= 5) {
        const length = backend.readUInt32BE(1) + 1;
        if (length < 5 || length > 1_048_576) {
          client.destroy();
          upstream.destroy();
          return;
        }
        if (backend.length < length) return;
        const frame = backend.subarray(0, length);
        backend = backend.subarray(length);
        if (
          point === "after-commit" &&
          frame[0] === 0x43 &&
          frame.subarray(5).toString("utf8") === "COMMIT\0"
        ) {
          // PostgreSQL executed COMMIT. Withhold CommandComplete and the
          // following ReadyForQuery; pg sees a genuine lost TCP connection.
          drop();
          return;
        }
        client.write(frame);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(ciUrl);
  url.port = String(address.port);
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
    application_name: "cookie-ci-commit-wire-fault",
  });
  pool.on("error", () => {
    // Expected idle-client disconnects are not an unhandled Node event.
  });
  try {
    await assert.rejects(command(pool), /connection terminated|ECONNRESET/i);
    assert.equal(dropped, 1, "must reach the precise PostgreSQL wire boundary");
    assert.equal(connections, 1, "transaction must not reconnect internally");
  } finally {
    for (const socket of sockets) socket.destroy();
    await pool.end();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }
}
