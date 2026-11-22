# F1 Appearance codec: private bounded Unix socket IPC candidate

Status: **PROPOSED — not activated**, refs #223/#203. This is the protocol layer for a future **separate OS-constrained** codec container, not a released upload feature. Independent open PRs #398 (POSIX subprocess-group containment) and #399 (real Linux Docker sandbox test) are not dependencies of the source files in this change. The API entrypoint and current Appearance HTTP adapter remain unchanged and **do not mount private uploads**.

## Strict contract

`codec-ipc-server-main.ts` is a dedicated Node worker entrypoint. The server imports the native Sharp codec. `codec-ipc-client.ts` is separate and imports no native image decoder, avoiding accidental Sharp loading in the API process. Communication uses **Unix-domain sockets only**, never TCP/HTTP and never a Docker socket.

A single v1 request is a fixed 12-byte header followed by **1–2,097,152 bytes**:

| Bytes | Meaning |
| --- | --- |
| 0–3 | ASCII `KCI1` |
| 4 | Protocol version `1` |
| 5 | MIME enum: `1=PNG`, `2=JPEG`, `3=WebP` |
| 6–7 | Reserved, **must be zero** |
| 8–11 | Unsigned big-endian byte count |
| 12+ | Raw binary raster, no JSON, names, paths, tokens, tenant IDs or URLs |

Each response consists of a 12-byte header (`KCO1`, version 1, status, zero reserved, unsigned big-endian payload count) followed by **at most 2 MiB + 8 bytes**. Status `0` carries an 8-byte unsigned width/height header and newly normalized PNG; status `1` is invalid-image, `2` output-too-large and `3` unavailable. Error statuses **never contain a body**. Client revalidates length, protocol version, reserved bits, dimensions, PNG signature and IHDR fields, never trusting a successful status on its own. Unknown status, truncation, excess bytes or malformed structure **fail closed**.

There is at most **one live request per worker**, from header parsing through decode and response closure. Any other incoming connection is promptly rejected as unavailable; no queue. **A declared length is not a complete request or response:** the client half-closes its Unix stream after the exact request bytes, and the server waits for clean request EOF before invoking the native decoder. The client waits for clean response EOF before accepting a success frame; a split late trailer, extra bytes, truncation, or a peer that never ends the stream fails closed. Both sides verify exact byte counts at EOF. Both ends enforce local technical deadlines (default 12 seconds, at most 15 seconds); an abandoned client does not release server admission while a native operation remains in progress. Resource leaks after unkillable native codec work still require OS cgroup/watchdog supervision.

## Socket authority and operator requirements

A private operator-provisioned parent directory must be a **real non-symlink directory**, owned by the nonroot worker UID with no world permissions and **no group write** (`0700` for same-UID test or `0750` for an authorized shared group). The server fails rather than unlinking a pre-existing socket path, refuses root/Windows startup and creates the socket with mode `0660` via a dedicated-worker umask. The client requires an absolute path and an **operator-supplied expected socket UID**, then verifies parent mode, real socket type, owner UID/group and socket mode before connecting. Ordinary user HTTP parameters cannot set any of these values.

Proposed two-container Linux arrangement **pending integration review**: bootstrap a dedicated shared Unix socket directory owned by sandbox UID 65532 and group containing the API principal, with group-execute but no group-write; the native worker runs with a different nonroot UID from the API and a read-only root/network-none container, the API sees only the socket mount without Docker orchestration privileges. **No remote peer attestation** is implemented: local POSIX owner/mode verification is the authority boundary, so the operator must protect mount namespaces, inode replacement and local privileged users. A compromised worker could abuse its own writable directory. Do not treat UID/mode checks as a substitute for isolation, seccomp, cgroups, IPC hardening and independent review.

The regular API is not automatically configured to use this candidate and **must never silently fall back to in-process or unrestricted subprocess decode if a required isolated endpoint fails**. Before any actual wiring, independently test the two-container shared-volume socket, strict cancellation and response stream handling, large/slow client and codec resource pressure, unexpected restart, socket peer identity, AuthN/AuthZ before decoding and at the transactional commit boundary, operator quota/rate limits, protected asset reads, physical browser UI, and compatibility with the actual deployment platform. Altare Sandbox/Go cannot run Docker-in-Docker; an assumed sidecar is not evidence of Altare support. Production/pilot/customer PII remain out of scope.
