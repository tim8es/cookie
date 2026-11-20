#!/usr/bin/env bash
# Linux Docker-only evidence for an OS-confined native Appearance codec.
# This is NOT wired into the API or approved for real uploads.
set -euo pipefail
[[ "${CI:-}" == "true" ]] || { echo "Synthetic CI=true required" >&2; exit 1; }
[[ "$(uname -s)" == "Linux" ]] || { echo "Linux Docker is required" >&2; exit 1; }
command -v docker >/dev/null
command -v python3 >/dev/null
work="$(mktemp -d)"
image="kuki-codec-sandbox-ci:${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
name="kuki-codec-proof-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
cleanup() {
  status=$?
  trap - EXIT
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT

# Separate isolated image: no built API, web bundle, database schema, or
# credentials. Build from the same pinned source/dependencies as real runtime.
docker build --target codec-sandbox -f docker/Dockerfile -t "$image" .

# Native RSS/CPU/PID bounds are Docker/cgroup-enforced; V8 heap alone cannot
# contain sharp/libvips. No host/network/DB socket or writable workspace mount.
docker run -d --name "$name" \
  --network none --read-only \
  --user 65532:65532 \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 192m --memory-swap 192m --cpus 0.5 --pids-limit 24 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m,uid=65532,gid=65532 \
  --entrypoint node "$image" -e 'setInterval(() => {}, 1000)' >/dev/null

# Inspect ACTUAL Docker HostConfig, not YAML or human assumptions.
docker inspect "$name" | python3 -c '
import json,sys
c=json.load(sys.stdin)[0]
h=c["HostConfig"]
assert c["State"]["Running"], "sandbox is not running"
assert c["Config"]["User"] == "65532:65532"
assert h["NetworkMode"] == "none", h["NetworkMode"]
assert h["ReadonlyRootfs"] is True
assert h["Privileged"] is False
assert h["Memory"] == 192 * 1024 * 1024, h["Memory"]
assert h["MemorySwap"] == h["Memory"], h["MemorySwap"]
assert h["NanoCpus"] == 500_000_000, h["NanoCpus"]
assert h["PidsLimit"] == 24, h["PidsLimit"]
assert "ALL" in h["CapDrop"], h["CapDrop"]
assert any("no-new-privileges" in x for x in h["SecurityOpt"]), h["SecurityOpt"]
assert not h["Binds"], "host bind mount unexpectedly present"
assert not c.get("Mounts", []), "unexpected externally mounted data"
assert len(h["Tmpfs"]) == 1 and "/tmp" in h["Tmpfs"], h["Tmpfs"]
print("PASS: real Docker network, user, filesystem, caps, cgroup and pid constraints")
'

# Observed runtime restrictions, independent of the Docker inspect claim.
docker exec "$name" node -e '
  const assert=require("node:assert/strict");
  const fs=require("node:fs");
  const os=require("node:os");
  assert.equal(process.getuid(),65532);
  const s=fs.readFileSync("/proc/self/status","utf8");
  assert.match(s,/^NoNewPrivs:\s+1$/m);
  assert.match(s,/^CapEff:\s+0+$/m);
  assert.ok(Object.keys(os.networkInterfaces()).every(n=>n==="lo"));
  assert.equal(fs.existsSync("/workspace/db/migrations"),false);
  assert.equal(fs.existsSync("/workspace/apps/web"),false);
  let wrote=false;
  try { fs.writeFileSync("/workspace/.forbidden-test-write","x"); wrote=true; }
  catch (e) { assert.ok(e.code==="EROFS" || e.code==="EACCES",e.code); }
  assert.equal(wrote,false);
  fs.writeFileSync("/tmp/synthetic-scratch","x");
  assert.equal(fs.readFileSync("/tmp/synthetic-scratch","utf8"),"x");
  console.log("PASS: non-root/no-net/no-caps/no-new-privs and read-only root observed");
'

# Real native sharp/libvips execution in the isolated compiled container.
# Build a synthetic raster there, send bytes over stdin and inspect the
# worker binary output on the host. No network, Docker socket or host path
# is available to the worker. The container is ephemeral and never deployed.
docker exec "$name" node --input-type=module -e '
  import sharp from "sharp";
  const img=await sharp({create:{width:3,height:2,channels:3,background:"red"}})
    .png().toBuffer();
  process.stdout.write(img);
' > "$work/input.png"
docker exec -i "$name" \
  node dist/packages/appearance-asset-adapter/src/codec-worker.js image/png \
  < "$work/input.png" > "$work/output.bin"
python3 - "$work/output.bin" <<'PY'
import sys,struct
p=open(sys.argv[1],"rb").read()
assert 41 <= len(p) <= 2097160, len(p)
width,height=struct.unpack(">II",p[:8])
assert (width,height)==(3,2), (width,height)
assert p[8:16]==bytes.fromhex("89504e470d0a1a0a"), p[8:16]
assert p[20:24]==b"IHDR"
assert struct.unpack(">II",p[24:32])==(width,height)
print("PASS: real compiled native codec produces bounded 3x2 PNG inside the sandbox")
PY

# Bad data must not yield a valid image or leak the raw decoder failure.
if printf 'not-an-image' | docker exec -i "$name" \
  node dist/packages/appearance-asset-adapter/src/codec-worker.js image/png \
  > "$work/bad.bin" 2> "$work/decoder.err"; then
  echo "Invalid raster was accepted by sandbox worker" >&2
  exit 1
fi
[[ ! -s "$work/decoder.err" && ! -s "$work/bad.bin" ]] || {
  echo "Sandbox worker emitted untrusted data or native error" >&2
  exit 1
}
echo "PASS: isolated codec rejects invalid raster with no output disclosure"
