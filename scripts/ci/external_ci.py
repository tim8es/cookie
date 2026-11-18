"""Private evidence and optional external CI dispatch. Python stdlib only.

Run the controller from a trusted environment; never from unreviewed PR code.
No actual repository names or credentials are stored in this file.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SUITES = ("quality", "postgres17", "staging")
SHA = re.compile(r"[0-9a-f]{40}\Z")
JOB = re.compile(r"[0-9a-f]{32}\Z")
SLUG = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*\Z")
MAX_ARCHIVE = 80 * 1024 * 1024
STEP_TIMEOUT = 2700


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api(token, path, method="GET", data=None, *, binary=False):
    url = "https://api.github.com" + path
    if binary:
        url = "https://uploads.github.com" + path
    body = data if binary else (None if data is None else json.dumps(data).encode())
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/zip" if binary else "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "private-ci-adapter",
    })
    # Never forward a credential to a redirected origin or print response bodies.
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=90) as response:
        result = response.read(4 * 1024 * 1024 + 1)
        if len(result) > 4 * 1024 * 1024:
            raise ValueError("API response too large")
        return json.loads(result) if result else None


def require_slug(value):
    if not SLUG.fullmatch(value) or any(p in (".", "..") for p in value.split("/")):
        raise ValueError("Invalid repository")
    return value


def private_repo(token, repo):
    repo = require_slug(repo)
    result = api(token, "/repos/" + repo)
    if result.get("private") is not True or result.get("full_name", "").lower() != repo.lower():
        raise ValueError("Private destination/source required")
    return repo


def executor_sha():
    expected = os.environ.get("CI_EXECUTION_SHA", "")
    if not SHA.fullmatch(expected):
        raise ValueError("Approved executor SHA required")
    return expected


def verify_executor_ref(token, runner, expected):
    if not SHA.fullmatch(expected):
        raise ValueError("Approved executor SHA required")
    ref = api(token, "/repos/" + require_slug(runner) + "/git/ref/heads/main")
    if not isinstance(ref, dict) or ref.get("object", {}).get("sha") != expected:
        raise ValueError("Executor main differs from reviewed revision")


def valid_run(run, run_id, expected):
    return (
        isinstance(expected, str) and SHA.fullmatch(expected) is not None
        and isinstance(run, dict) and type(run.get("id")) is int
        and run["id"] == run_id and run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == "main" and run.get("head_sha") == expected
        and isinstance(run.get("path"), str)
        and run["path"].split("@")[0] == ".github/workflows/universal.yml"
        and type(run.get("run_attempt")) is int and run["run_attempt"] == 1
    )


def manifest(source, commit, suite):
    if not SHA.fullmatch(commit) or suite not in SUITES:
        raise ValueError("Invalid CI request")
    return {
        "schemaVersion": "task-runner/v1",
        "source": {"repository": require_slug(source), "commit": commit},
        "execution": {"workingDirectory": ".", "steps": [{
            "argv": ["python3", "scripts/ci/external_ci.py", "worker", suite, commit],
            "timeoutSeconds": STEP_TIMEOUT,
        }]},
        "environment": {
            "CI_EVIDENCE_REPO": {"secret": "ci_evidence_repo"},
            "CI_EVIDENCE_TOKEN": {"secret": "ci_evidence_write_token"},
        },
    }


def worker_env():
    # Do not pass result-store credentials, runner credentials, or Actions
    # command-file variables into dependency install/test processes.
    allowed = {"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL",
               "TMPDIR", "SHELL", "SSL_CERT_FILE", "SSL_CERT_DIR"}
    return {k: v for k, v in os.environ.items() if k in allowed} | {"CI": "true"}


def run_tests(suite, logfile):
    with logfile.open("wb") as log:
        process = subprocess.Popen(
            ["npm", "exec", "--yes", "--package=node@26", "--package=pnpm@10.24.0",
             "--", "bash", "scripts/ci/run-suite.sh", suite],
            cwd=ROOT, env=worker_env(), stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        try:
            return process.wait(timeout=2250)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return 124


def make_archive(path, logfile, suite):
    files = [(logfile, "ci.log")]
    if suite == "quality":
        evidence = ROOT / "apps/web/artifacts/visual-smoke"
        if evidence.is_dir() and not evidence.is_symlink():
            files.extend((p, "visual/" + p.name) for p in sorted(evidence.iterdir())
                         if p.is_file() and not p.is_symlink()
                         and (p.suffix == ".png" or p.name == "manifest.json"))
    if sum(p.stat().st_size for p, _ in files) > MAX_ARCHIVE:
        raise ValueError("Evidence exceeds size limit")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file, name in files:
            archive.write(file, name)
    if path.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Evidence exceeds size limit")


def publish(token, repo, job, report, archive):
    private_repo(token, repo)
    content = archive.read_bytes()
    report = report | {"archiveSha256": hashlib.sha256(content).hexdigest()}
    release = api(token, "/repos/" + repo + "/releases", "POST", {
        "tag_name": job, "name": job, "body": json.dumps(report),
        "draft": True, "prerelease": True,
    })
    if type(release.get("id")) is not int:
        raise ValueError("Release creation failed")
    asset = api(token, "/repos/" + repo + "/releases/" + str(release["id"])
                + "/assets?name=evidence.zip", "POST", content, binary=True)
    if (asset.get("state") != "uploaded" or asset.get("size") != len(content)
            or asset.get("digest") != "sha256:" + report["archiveSha256"]):
        raise ValueError("Evidence upload unverifiable")
    published = api(token, "/repos/" + repo + "/releases/" + str(release["id"]),
                    "PATCH", {"draft": False})
    if published.get("draft") is not False:
        raise ValueError("Evidence publication failed")


def task_runner_provenance():
    run_id = int(os.environ["TASK_RUNNER_RUN_ID"])
    attempt = int(os.environ["TASK_RUNNER_RUN_ATTEMPT"])
    if run_id < 1 or attempt < 1:
        raise ValueError("Invalid runner provenance")
    return run_id, attempt


def worker(suite, commit):
    job = os.environ["TASK_JOB_ID"]
    run_id, attempt = task_runner_provenance()
    token = os.environ["CI_EVIDENCE_TOKEN"]
    repo = private_repo(token, os.environ["CI_EVIDENCE_REPO"])
    if not JOB.fullmatch(job) or not SHA.fullmatch(commit) or suite not in SUITES:
        raise ValueError("Invalid execution")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT,
                                     env=worker_env(), text=True).strip()
    if actual != commit:
        raise ValueError("Source SHA mismatch")
    with tempfile.TemporaryDirectory(prefix="ci-evidence-") as tmp:
        logfile, archive = Path(tmp) / "ci.log", Path(tmp) / "evidence.zip"
        code = run_tests(suite, logfile)
        make_archive(archive, logfile, suite)
        publish(token, repo, job, {
            "schema": 1, "jobId": job, "commit": commit,
            "suite": suite, "exitCode": code, "runId": run_id, "runAttempt": attempt,
        }, archive)
        return 0 if code == 0 else 1


def valid_evidence(release, job, commit, suite, run_id, attempt, *, require_success=True):
    try:
        report = json.loads(release["body"])
        asset = [a for a in release["assets"] if a["name"] == "evidence.zip"]
        return (
            type(report["schema"]) is int and report["schema"] == 1
            and report["jobId"] == job and report["commit"] == commit
            and type(report["runId"]) is int and report["runId"] == run_id
            and type(report["runAttempt"]) is int and report["runAttempt"] == attempt
            and report["suite"] == suite and type(report["exitCode"]) is int
            and (report["exitCode"] == 0 if require_success else -255 <= report["exitCode"] <= 255)
            and release["tag_name"] == job
            and release.get("draft") is False and len(asset) == 1
            and asset[0]["state"] == "uploaded"
            and 0 < asset[0]["size"] <= MAX_ARCHIVE
            and re.fullmatch(r"[0-9a-f]{64}", report["archiveSha256"]) is not None
            and asset[0]["digest"] == "sha256:" + report["archiveSha256"]
        )
    except (KeyError, TypeError, ValueError):
        return False


def dispatch(source, commit):
    # Explicit opt-in only. This is not a policy authorization or a trusted
    # PR approval: the operator must establish both before using it.
    if os.environ.get("EXTERNAL_CI_APPROVED") != "1":
        raise ValueError("External execution is disabled")
    if not SHA.fullmatch(commit):
        raise ValueError("Exact source commit required")
    import base64
    source_token = os.environ["CI_SOURCE_STATUS_TOKEN"]
    registry_token = os.environ["CI_REGISTRY_WRITE_TOKEN"]
    runner_token = os.environ["CI_RUNNER_DISPATCH_TOKEN"]
    evidence_token = os.environ["CI_EVIDENCE_READ_TOKEN"]
    source = private_repo(source_token, source)
    registry = private_repo(registry_token, os.environ["CI_REGISTRY_REPO"])
    evidence = private_repo(evidence_token, os.environ["CI_EVIDENCE_REPO"])
    runner = require_slug(os.environ["CI_EXECUTION_REPO"])
    expected_executor = executor_sha()
    verify_executor_ref(runner_token, runner, expected_executor)
    if len({r.lower() for r in (source, registry, evidence, runner)}) != 4:
        raise ValueError("Separate trust destinations required")
    ref = os.environ.get("CI_REGISTRY_REF", "main")
    if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_./-]{0,149}", ref) or ".." in ref:
        raise ValueError("Invalid registry ref")
    actual = api(source_token, "/repos/" + source + "/commits/" + commit)
    if actual.get("sha") != commit:
        raise ValueError("Unknown source commit")
    runs = {}
    pending = set()

    def status(suite, state, description):
        api(source_token, "/repos/" + source + "/statuses/" + commit, "POST", {
            "context": "External F1 / " + suite, "state": state,
            "description": description,
        })

    try:
        for suite in SUITES:
            status(suite, "pending", "Awaiting verified external CI")
            pending.add(suite)
        for suite in SUITES:
            job = secrets.token_hex(16)
            encoded = base64.b64encode(json.dumps(manifest(source, commit, suite)).encode()).decode()
            api(registry_token, "/repos/" + registry + "/contents/jobs/" + job + ".json",
                "PUT", {"message": "Create execution request", "content": encoded, "branch": ref})
            verify_executor_ref(runner_token, runner, expected_executor)
            result = api(runner_token, "/repos/" + runner + "/actions/workflows/universal.yml/dispatches",
                         "POST", {"ref": "main", "inputs": {"job_id": job}, "return_run_details": True})
            run_id = result.get("workflow_run_id") if isinstance(result, dict) else None
            if type(run_id) is not int or run_id < 1:
                raise ValueError("No verified run ID returned")
            runs[suite] = (job, run_id)
        deadline = time.monotonic() + 3600
        failed = False
        while pending:
            if time.monotonic() > deadline:
                raise TimeoutError("Execution deadline exceeded")
            for suite in tuple(pending):
                job, run_id = runs[suite]
                run = api(runner_token, "/repos/" + runner + "/actions/runs/" + str(run_id))
                if not valid_run(run, run_id, expected_executor):
                    raise ValueError("Unexpected workflow run")
                if run.get("status") != "completed":
                    continue
                passed = False
                if run.get("conclusion") == "success":
                    release = api(evidence_token, "/repos/" + evidence + "/releases/tags/" + job)
                    passed = valid_evidence(release, job, commit, suite, run_id, 1)
                status(suite, "success" if passed else "failure",
                       "Verified private evidence" if passed else "Execution or evidence failed")
                failed |= not passed
                pending.remove(suite)
            if pending:
                time.sleep(15)
        return 1 if failed else 0
    finally:
        # Cancellation, API errors and incomplete evidence cannot become green.
        for suite in pending:
            if suite in runs:
                try:
                    api(runner_token, "/repos/" + runner + "/actions/runs/" + str(runs[suite][1]) + "/cancel", "POST")
                except Exception:
                    pass
            try:
                status(suite, "error", "External CI incomplete")
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("source")
    plan.add_argument("commit")
    plan.add_argument("suite", choices=SUITES)
    run = commands.add_parser("worker")
    run.add_argument("suite", choices=SUITES)
    run.add_argument("commit")
    send = commands.add_parser("dispatch")
    send.add_argument("source")
    send.add_argument("commit")
    args = parser.parse_args()
    try:
        if args.command == "plan":
            print(json.dumps(manifest(args.source, args.commit, args.suite), indent=2))
            return 0
        if args.command == "worker":
            return worker(args.suite, args.commit)
        return dispatch(args.source, args.commit)
    except (Exception, KeyboardInterrupt):
        # This command can run on a metadata-visible host: no raw details.
        print("CI adapter failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
