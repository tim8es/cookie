# F1 Linux codec container isolation proof (candidate, disabled)

Refs #223 / #203; independent of POSIX process-group PR #398. **This is an actual Docker-namespace/cgroup isolation test of a dedicated compiled codec image, not an activated HTTP upload or an Altare deployment.** The ordinary API still uses its existing subprocess; the private binary upload adapter remains unmounted in `apps/api/src/main.ts`.

## What is concretely enforced and checked

`docker/Dockerfile` contains a separate `codec-sandbox` build target. It includes compiled image codec code and pinned native `sharp` dependencies but **no application API binary, migration directory, web bundle, database, customer files or credentials**. Its image default user is UID/GID 65532. **The image alone confers no isolation.**

The isolated runner in `scripts/ci-codec-sandbox-smoke.sh` starts this image **in Linux Docker** with all of the following options; these are technical resource bounds for synthetic testing, not commercial plan quotas:

- `--network none` and no published ports, host mounts, Docker socket, database environment or external services;
- `--read-only`; only a bounded (`8m`) `/tmp` tmpfs with `noexec,nosuid,nodev`;
- `--user 65532:65532`, `--cap-drop ALL`, `--security-opt no-new-privileges`;
- kernel/cgroup limits `--memory 192m`, `--memory-swap 192m`, `--cpus 0.5`, `--pids-limit 24`;
- the Docker engine's default seccomp profile, not an unreviewed `seccomp=unconfined` override.

The CI test checks the **actual running container's** Docker HostConfig and processes: non-root UID, `NoNewPrivs=1`, no effective capabilities, no non-loopback interfaces, root write denied, tmpfs scratch allowed, no API/data paths. It sends a real 3×2 synthetic raster into the compiled `codec-worker.js` and validates the freshly normalized bounded PNG binary response. Bad input must fail without yielding native stderr/data. It is invoked by the existing compulsory compiled staging Compose job and only with `CI=true`.

Reference for host-enforced Compose/runtime limits: [Docker Compose container specification](https://docs.docker.com/reference/compose-file/container-spec/).

## What is not ready

**Do not mount upload in real runtime from this candidate alone.** There is currently **no channel from the API to the isolated container**. Before any deployment, independently design a bounded, authenticated, private IPC (for instance a Unix domain socket with strict filesystem permissions, one outstanding request and fixed protocol) without a Docker socket or general container orchestration rights inside the API. Preserve the existing server-side tenant authorization **before** passing bytes and **after** normalization, revalidate at the transactional persistence boundary, and fail closed if the isolation environment is missing or the IPC fails.

The test uses local Linux Docker. **Altare Sandbox / Go do not provide Docker-in-Docker**; no claim is made that a standalone Altare App Hosting instance supports this sidecar, quotas, OCI runtime or namespace controls. A supported deployment with separately audited isolation (or dedicated isolated worker service) must be selected and measured. Real container-out-of-memory behaviour, CPU/pids abuse, restart/liveness, concurrency across API instances, storage retention, request ingress/slow-body timeouts, authorized read limits, physical device verification, open-source image dependency review and actual browser owner upload/publish still require separate approval and evidence. Full public salon booking URL/assets #222 and commercial/security gates #37/#113/#165 remain blocked.

No new runtime flags, public routes, standalone operational deployment or customer PII in this candidate.
