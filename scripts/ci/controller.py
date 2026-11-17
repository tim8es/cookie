"""Trusted, private scheduled controller. Never execute from a PR checkout.

Run once per minute from a dedicated Linux service with a durable, private
state directory. No GitHub-hosted job waits for the tests to finish.
"""
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
import urllib.error

import external_ci as ci

CONTEXT = "External F1 / "
ACTIVE_LIMIT = 4
DEADLINE = 3600


def pages(token, path):
    result = []
    for page in range(1, 11):
        suffix = "&" if "?" in path else "?"
        batch = ci.api(token, path + suffix + "per_page=100&page=" + str(page))
        if not isinstance(batch, list):
            raise ValueError("Invalid paginated response")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise ValueError("Incomplete API listing")


def approved(reviews, head, reviewers):
    # A comment does not revoke an earlier approval; a dismissal or request
    # for changes does. A previous commit's approval never authorizes a new SHA.
    latest = {}
    for review in sorted(reviews, key=lambda r: r["id"]):
        login = review.get("user", {}).get("login", "").lower()
        if login in reviewers and review.get("state") in (
            "APPROVED", "CHANGES_REQUESTED", "DISMISSED"
        ):
            latest[login] = review
    return (any(r["state"] == "APPROVED" and r.get("commit_id") == head
                for r in latest.values())
            and not any(r["state"] == "CHANGES_REQUESTED" for r in latest.values()))


def candidate(pr, source, base, reviews, reviewers):
    if (pr.get("state") != "open" or pr.get("draft") is not False
            or pr.get("mergeable") is not True):
        return None
    head = pr["head"]
    target = pr["base"]
    source_id = source.lower()
    if (head.get("repo", {}).get("full_name", "").lower() != source_id
            or target.get("repo", {}).get("full_name", "").lower() != source_id
            or target.get("ref") != base):
        return None
    sha, base_sha, merge = head.get("sha"), target.get("sha"), pr.get("merge_commit_sha")
    if not all(isinstance(x, str) and ci.SHA.fullmatch(x) for x in (sha, base_sha, merge)):
        return None
    if not approved(reviews, sha, reviewers):
        return None
    return {"head": sha, "base": base_sha, "commit": merge}


class Controller:
    def __init__(self, source, root):
        if os.environ.get("EXTERNAL_CI_APPROVED") != "1":
            raise ValueError("External provider disabled")
        self.source_token = os.environ["CI_SOURCE_STATUS_TOKEN"]
        self.registry_token = os.environ["CI_REGISTRY_WRITE_TOKEN"]
        self.runner_token = os.environ["CI_RUNNER_DISPATCH_TOKEN"]
        self.evidence_token = os.environ["CI_EVIDENCE_READ_TOKEN"]
        self.source = ci.private_repo(self.source_token, source)
        self.registry = ci.private_repo(self.registry_token, os.environ["CI_REGISTRY_REPO"])
        self.evidence = ci.private_repo(self.evidence_token, os.environ["CI_EVIDENCE_REPO"])
        self.runner = ci.require_slug(os.environ["CI_EXECUTION_REPO"])
        if len({s.lower() for s in (self.source, self.registry, self.evidence, self.runner)}) != 4:
            raise ValueError("Separate repositories required")
        self.ref = os.environ.get("CI_REGISTRY_REF", "main")
        # Only main is supported by this controller. No untrusted ref selection.
        if self.ref != "main":
            raise ValueError("Unsupported registry ref")
        self.base = "main"
        self.reviewers = {r.strip().lower() for r in
                          os.environ["CI_TRUSTED_REVIEWERS"].split(",") if r.strip()}
        if not self.reviewers:
            raise ValueError("Explicit review allowlist required")
        self.root = root
        self.state_path = root / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        if not isinstance(self.state, dict):
            raise ValueError("Invalid journal")

    def save(self):
        with tempfile.NamedTemporaryFile(mode="w", dir=self.root, delete=False) as file:
            json.dump(self.state, file, sort_keys=True)
            file.flush()
            os.fsync(file.fileno())
            tmp = file.name
        os.replace(tmp, self.state_path)
        fd = os.open(self.root, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def src(self, suffix, method="GET", data=None):
        return ci.api(self.source_token, "/repos/" + self.source + suffix, method, data)

    def run_api(self, suffix, method="GET", data=None):
        return ci.api(self.runner_token, "/repos/" + self.runner + suffix, method, data)

    def status(self, record, suite, value, description):
        self.src("/statuses/" + record["commit"], "POST", {
            "state": value, "context": CONTEXT + suite, "description": description,
        })

    def snapshot(self, number):
        pr = self.src("/pulls/" + str(number))
        if pr.get("state") == "open" and pr.get("mergeable") is None:
            return "unknown"
        reviews = pages(self.source_token, "/repos/" + self.source + "/pulls/" +
                        str(number) + "/reviews")
        result = candidate(pr, self.source, self.base, reviews, self.reviewers)
        if result:
            merge = self.src("/commits/" + result["commit"])
            parents = [p["sha"] for p in merge.get("parents", [])]
            if (merge.get("sha") != result["commit"]
                    or parents != [result["base"], result["head"]]):
                return "unknown"
        return result

    def submit(self, record, suite):
        item = record["suites"][suite]
        # Persist intent before any side effect. Ambiguous network failures
        # are not retried automatically, including after a controller crash.
        item["phase"] = "submitting"
        item["job"] = secrets.token_hex(16)
        self.save()
        try:
            self.status(record, suite, "pending", "Awaiting verified external CI")
            encoded = base64.b64encode(json.dumps(ci.manifest(
                self.source, record["commit"], suite)).encode()).decode()
            ci.api(self.registry_token, "/repos/" + self.registry + "/contents/jobs/" +
                   item["job"] + ".json", "PUT", {
                       "message": "Create execution request", "content": encoded, "branch": self.ref,
                   })
            result = self.run_api("/actions/workflows/universal.yml/dispatches", "POST", {
                "ref": "main", "inputs": {"job_id": item["job"]}, "return_run_details": True,
            })
            run_id = result.get("workflow_run_id") if isinstance(result, dict) else None
            if type(run_id) is not int or run_id < 1:
                raise ValueError("Missing run identity")
            item.update(phase="running", run=run_id)
            self.save()
        except Exception:
            # An operator must reconcile any uncertain run from the journal.
            item["phase"] = "uncertain"
            self.save()

    def reconcile(self, record, suite, current):
        item = record["suites"][suite]
        phase = item["phase"]
        stale = current != "unknown" and current != {
            k: record[k] for k in ("head", "base", "commit")
        }
        expired = time.time() - record["created"] >= DEADLINE
        if stale or (expired and phase not in ("success", "failure", "error", "obsolete")):
            if phase in ("running", "cancelling"):
                item["phase"] = "cancelling"
                self.save()
                run = self.run_api("/actions/runs/" + str(item["run"]))
                if run.get("status") != "completed":
                    self.run_api("/actions/runs/" + str(item["run"]) + "/cancel", "POST")
                    return
            if phase != "obsolete":
                self.status(record, suite, "error", "External CI obsolete or expired")
                item["phase"] = "obsolete"
                self.save()
            return
        if phase in ("submitting", "uncertain"):
            self.status(record, suite, "error", "External dispatch requires reconciliation")
            item["phase"] = "error"
            self.save()
        elif phase == "new" and current != "unknown":
            self.submit(record, suite)
        elif phase == "running" and current != "unknown":
            run = self.run_api("/actions/runs/" + str(item["run"]))
            if run.get("status") != "completed":
                return
            passed = False
            if (run.get("id") == item["run"] and run.get("event") == "workflow_dispatch"
                    and run.get("head_branch") == "main"
                    and run.get("path", "").split("@")[0] == ".github/workflows/universal.yml"
                    and run.get("run_attempt") == 1 and run.get("conclusion") == "success"):
                try:
                    release = ci.api(self.evidence_token, "/repos/" + self.evidence +
                                     "/releases/tags/" + item["job"])
                    passed = ci.valid_evidence(release, item["job"], record["commit"],
                                               suite, item["run"], 1)
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
            # Re-read source after result retrieval to avoid promoting a stale
            # merge SHA or dismissed approval. Status is always SHA-scoped.
            fresh = self.snapshot(record["pr"])
            if fresh == "unknown":
                return
            if fresh != current:
                self.status(record, suite, "error", "External CI obsolete")
                item["phase"] = "obsolete"
            else:
                self.status(record, suite, "success" if passed else "failure",
                            "Verified private evidence" if passed else "Execution or evidence failed")
                item["phase"] = "success" if passed else "failure"
            self.save()

    def tick(self):
        prs = pages(self.source_token, "/repos/" + self.source + "/pulls?state=open&base=main")
        numbers = {p["number"] for p in prs}
        current = {number: self.snapshot(number) for number in numbers}
        terminal = {"success", "failure", "error", "obsolete"}
        # Visit old records first: cancel superseded work before new dispatch.
        for record in self.state.values():
            result = current.get(record["pr"])
            for suite in ci.SUITES:
                self.reconcile(record, suite, result)
        active = sum(any(s["phase"] not in terminal for s in r["suites"].values())
                     for r in self.state.values())
        for number, result in sorted(current.items()):
            if not isinstance(result, dict) or active >= ACTIVE_LIMIT:
                continue
            key = str(number) + ":" + result["commit"]
            if key in self.state:
                continue
            record = {"pr": number, **result, "created": int(time.time()),
                      "suites": {suite: {"phase": "new"} for suite in ci.SUITES}}
            self.state[key] = record
            self.save()
            active += 1
            for suite in ci.SUITES:
                # A changed revision cannot start further suites.
                fresh = self.snapshot(number)
                self.reconcile(record, suite, fresh)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        os.umask(0o077)
        args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if args.state_dir.is_symlink() or args.state_dir.stat().st_mode & 0o077:
            raise ValueError("Private state directory required")
        with (args.state_dir / "controller.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            Controller(args.source, args.state_dir).tick()
        return 0
    except Exception:
        print("External reconciliation incomplete")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
