import base64
import json
import unittest
from unittest.mock import Mock, patch

import controller as ctl


class ControllerContract(unittest.TestCase):
    def setUp(self):
        self.head = "a" * 40
        self.base = "b" * 40
        self.merge = "c" * 40
        self.source = "example/private"
        self.reviewers = {"reviewer"}
        self.review = {"id": 1, "user": {"login": "reviewer"},
                       "state": "APPROVED", "commit_id": self.head}
        self.pr = {"state": "open", "draft": False, "mergeable": True,
                   "head": {"sha": self.head, "repo": {"full_name": self.source}},
                   "base": {"sha": self.base, "ref": "main",
                            "repo": {"full_name": self.source}},
                   "merge_commit_sha": self.merge}

    def select(self, reviews=None):
        return ctl.candidate(self.pr, self.source, "main",
                             [self.review] if reviews is None else reviews, self.reviewers)

    def test_exact_reviewed_internal_merge(self):
        self.assertEqual(self.select(), {"head": self.head, "base": self.base,
                                       "commit": self.merge})
        self.pr["head"]["sha"] = "d" * 40
        self.assertIsNone(self.select())

    def test_fork_deleted_repo_and_draft_are_not_trusted(self):
        self.pr["head"]["repo"] = {"full_name": "other/fork"}
        self.assertIsNone(self.select())
        self.pr["head"]["repo"] = None
        self.assertIsNone(self.select())
        self.pr["head"]["repo"] = {"full_name": self.source}
        self.pr["draft"] = True
        self.assertIsNone(self.select())

    def test_approval_revocation_and_comment(self):
        comment = dict(self.review, id=2, state="COMMENTED")
        self.assertIsNotNone(self.select([self.review, comment]))
        for state in ("DISMISSED", "CHANGES_REQUESTED"):
            self.assertIsNone(self.select([self.review, dict(comment, state=state)]))
        self.assertIsNone(self.select([dict(self.review, user={"login": "outsider"})]))

    def controller(self, phase):
        c = object.__new__(ctl.Controller)
        c.status = Mock()
        c.save = Mock()
        c.run_api = Mock()
        c.submit = Mock()
        c.snapshot = Mock()
        c.evidence_token = "synthetic"
        c.evidence = "example/results"
        record = {"pr": 7, "head": self.head, "base": self.base,
                  "commit": self.merge, "created": 1000,
                  "suites": {"quality": {"phase": phase, "run": 42, "job": "f" * 32}}}
        return c, record

    @patch.object(ctl.time, "time", return_value=1001)
    def test_superseded_run_is_cancelled_before_any_success(self, _):
        c, record = self.controller("running")
        c.run_api.return_value = {"status": "in_progress"}
        c.reconcile(record, "quality", None)
        self.assertEqual(record["suites"]["quality"]["phase"], "cancelling")
        c.run_api.assert_called_with("/actions/runs/42/cancel", "POST")
        c.status.assert_not_called()
        c.run_api.return_value = {"status": "completed", "conclusion": "success"}
        c.reconcile(record, "quality", None)
        self.assertEqual(record["suites"]["quality"]["phase"], "obsolete")
        self.assertEqual(c.status.call_args.args[2], "error")

    @patch.object(ctl.time, "time", return_value=1001)
    def test_ambiguous_dispatch_never_retries(self, _):
        c, record = self.controller("submitting")
        c.reconcile(record, "quality", self.select())
        self.assertEqual(record["suites"]["quality"]["phase"], "error")
        c.submit.assert_not_called()
        c.run_api.assert_not_called()

    @patch.object(ctl.time, "time", return_value=1001)
    def test_unknown_merge_does_not_dispatch_or_promote(self, _):
        c, record = self.controller("new")
        c.reconcile(record, "quality", "unknown")
        c.submit.assert_not_called()
        c.status.assert_not_called()

    @patch.object(ctl.time, "time", return_value=1001)
    def test_rerun_is_not_accepted_as_original_execution(self, _):
        c, record = self.controller("running")
        c.snapshot.return_value = self.select()
        c.run_api.return_value = {"status": "completed", "conclusion": "success",
                                  "id": 42, "event": "workflow_dispatch", "head_branch": "main",
                                  "path": ".github/workflows/universal.yml", "run_attempt": 2}
        c.reconcile(record, "quality", self.select())
        self.assertEqual(record["suites"]["quality"]["phase"], "failure")
        self.assertEqual(c.status.call_args.args[2], "failure")

    @patch.object(ctl.time, "time", return_value=1001)
    def test_revision_changes_during_reconciliation(self, _):
        c, record = self.controller("running")
        c.snapshot.return_value = None
        c.run_api.return_value = {"status": "completed", "conclusion": "failure"}
        c.reconcile(record, "quality", self.select())
        self.assertEqual(record["suites"]["quality"]["phase"], "obsolete")
        self.assertEqual(c.status.call_args.args[2], "error")


    @patch.object(ctl.time, "time", return_value=1001)
    def test_dispatch_to_reconcile_roundtrip_without_credentials(self, _):
        c, record = self.controller("new")
        c.submit = ctl.Controller.submit.__get__(c)
        c.source = self.source
        c.registry = "example/registry"
        c.registry_token = "synthetic"
        c.ref = "main"
        c.snapshot.return_value = self.select()
        c.run_api.return_value = {"workflow_run_id": 42}
        job = "e" * 32
        digest = "f" * 64
        with patch.object(ctl.secrets, "token_hex", return_value=job), patch.object(ctl.ci, "api") as api:
            c.reconcile(record, "quality", self.select())
            c.run_api.assert_called_once_with(
                "/actions/workflows/universal.yml/dispatches", "POST",
                {"ref": "main", "inputs": {"job_id": job}})
            manifest = json.loads(base64.b64decode(api.call_args.args[3]["content"]))
            self.assertEqual(manifest, ctl.ci.manifest(self.source, self.merge, "quality"))
            self.assertEqual(record["suites"]["quality"]["phase"], "running")
            self.assertEqual(c.status.call_args.args[2], "pending")

            c.run_api.return_value = {
                "id": 42, "status": "completed", "conclusion": "success",
                "event": "workflow_dispatch", "head_branch": "main",
                "path": ".github/workflows/universal.yml", "run_attempt": 1,
            }
            api.return_value = {
                "tag_name": job, "draft": False,
                "body": json.dumps({"schema": 1, "jobId": job, "commit": self.merge,
                                    "suite": "quality", "exitCode": 0, "runId": 42,
                                    "runAttempt": 1, "archiveSha256": digest}),
                "assets": [{"name": "evidence.zip", "size": 10, "state": "uploaded",
                            "digest": "sha256:" + digest}],
            }
            c.reconcile(record, "quality", self.select())
            self.assertEqual(record["suites"]["quality"]["phase"], "success")
            self.assertEqual(c.status.call_args.args[2], "success")
            self.assertEqual(c.status.call_args.kwargs["evidence_job"], job)
            c.run_api.reset_mock()
            c.reconcile(record, "quality", self.select())
            c.run_api.assert_not_called()

    def test_private_repo_uses_only_private_self_hosted_runner(self):
        workflow = (ctl.ROOT / ".github/workflows/f1-ci.yml").read_text()
        selector = "runs-on: ${{ github.event.repository.private && 'cookie-ci-private' || 'ubuntu-latest' }}"
        self.assertEqual(workflow.count(selector), 3)
        self.assertNotIn("vars.F1_EXECUTION_BACKEND", workflow)


if __name__ == "__main__":
    unittest.main()
