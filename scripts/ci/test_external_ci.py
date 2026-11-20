import json
import os
import unittest
from unittest.mock import patch

import external_ci as ci


class ExternalCIContract(unittest.TestCase):
    def setUp(self):
        self.commit = "a" * 40
        self.job = "b" * 32
        self.digest = "c" * 64
        self.release = {
            "tag_name": self.job, "draft": False,
            "body": json.dumps({"schema": 1, "jobId": self.job,
                                "commit": self.commit, "suite": "quality",
                                "exitCode": 0, "archiveSha256": self.digest,
                                "runId": 42, "runAttempt": 1}),
            "assets": [{"name": "evidence.zip", "size": 10, "state": "uploaded",
                        "digest": "sha256:" + self.digest}],
        }

    def test_manifest_pins_commit_and_uses_only_secret_aliases(self):
        plan = ci.manifest("example/private", self.commit, "quality")
        self.assertEqual(plan["source"]["commit"], self.commit)
        self.assertEqual(plan["schemaVersion"], "task-runner/v1")
        self.assertEqual(plan["environment"]["CI_EVIDENCE_TOKEN"],
                         {"secret": "ci_evidence_write_token"})
        for bad in ("main", "a" * 39):
            with self.assertRaises(ValueError):
                ci.manifest("example/private", bad, "quality")
        with self.assertRaises(ValueError):
            ci.manifest("example/private", self.commit, "unknown")

    def test_private_repo_fail_closed(self):
        with patch.object(ci, "api", return_value={"private": False, "full_name": "example/private"}):
            with self.assertRaises(ValueError):
                ci.private_repo("fake", "example/private")
        with patch.object(ci, "api", return_value={"private": True, "full_name": "other/private"}):
            with self.assertRaises(ValueError):
                ci.private_repo("fake", "example/private")

    def test_evidence_binds_exact_suite_job_commit_and_digest(self):
        self.assertTrue(ci.valid_evidence(self.release, self.job, self.commit, "quality", 42, 1))
        self.assertFalse(ci.valid_evidence(self.release, "d" * 32, self.commit, "quality", 42, 1))
        self.assertFalse(ci.valid_evidence(self.release, self.job, "d" * 40, "quality", 42, 1))
        self.assertFalse(ci.valid_evidence(self.release, self.job, self.commit, "staging", 42, 1))
        self.assertFalse(ci.valid_evidence(self.release, self.job, self.commit, "quality", 43, 1))
        self.assertFalse(ci.valid_evidence(self.release, self.job, self.commit, "quality", 42, 2))
        self.release["assets"][0]["digest"] = "sha256:" + "d" * 64
        self.assertFalse(ci.valid_evidence(self.release, self.job, self.commit, "quality", 42, 1))

    def test_failed_or_missing_evidence_is_not_success(self):
        report = json.loads(self.release["body"])
        report["exitCode"] = 1
        self.release["body"] = json.dumps(report)
        self.assertFalse(ci.valid_evidence(self.release, self.job, self.commit, "quality", 42, 1))
        self.assertTrue(ci.valid_evidence(self.release, self.job, self.commit, "quality", 42, 1, require_success=False))
        self.release["assets"] = []
        self.assertFalse(ci.valid_evidence(self.release, self.job, self.commit, "quality", 42, 1))
        self.assertFalse(ci.valid_evidence({}, self.job, self.commit, "quality", 42, 1))

    def test_worker_reads_valid_task_runner_provenance(self):
        with patch.dict(os.environ, {"TASK_RUNNER_RUN_ID": "42",
                                    "TASK_RUNNER_RUN_ATTEMPT": "2"}, clear=True):
            self.assertEqual(ci.task_runner_provenance(), (42, 2))
        for values in (
            {"TASK_RUNNER_RUN_ID": "0", "TASK_RUNNER_RUN_ATTEMPT": "1"},
            {"TASK_RUNNER_RUN_ID": "42", "TASK_RUNNER_RUN_ATTEMPT": "0"},
            {"TASK_RUNNER_RUN_ID": "bad", "TASK_RUNNER_RUN_ATTEMPT": "1"},
        ):
            with patch.dict(os.environ, values, clear=True), self.assertRaises(ValueError):
                ci.task_runner_provenance()

    def test_worker_env_excludes_tokens_and_output_channels(self):
        with patch.dict(os.environ, {"PATH": "/usr/bin", "CI_EVIDENCE_TOKEN": "fake",
                                    "TASK_RUNNER_ACCESS_TOKEN": "fake", "GITHUB_OUTPUT": "/fake",
                                    "ACTIONS_RUNTIME_TOKEN": "fake", "GITHUB_RUN_ID": "42",
                                    "GITHUB_RUN_ATTEMPT": "2", "TASK_RUNNER_RUN_ID": "42",
                                    "TASK_RUNNER_RUN_ATTEMPT": "2"}, clear=True):
            self.assertEqual(ci.worker_env(), {"PATH": "/usr/bin", "CI": "true"})

    def test_executor_sha_must_be_explicit_and_full(self):
        for value in ("", "main", "a" * 39):
            with patch.dict(os.environ, {"CI_EXECUTION_SHA": value}, clear=True):
                with self.assertRaises(ValueError):
                    ci.executor_sha()
        with patch.dict(os.environ, {"CI_EXECUTION_SHA": self.commit}, clear=True):
            self.assertEqual(ci.executor_sha(), self.commit)

    def test_executor_main_must_match_reviewed_ref(self):
        with patch.object(ci, "api", return_value={"object": {"sha": self.commit}}):
            ci.verify_executor_ref("fake", "example/executor", self.commit)
        with patch.object(ci, "api", return_value={"object": {"sha": "d" * 40}}):
            with self.assertRaises(ValueError):
                ci.verify_executor_ref("fake", "example/executor", self.commit)

    def test_run_rejects_wrong_executor_revision_and_attempt(self):
        run = {"id": 42, "event": "workflow_dispatch", "head_branch": "main",
               "path": ".github/workflows/universal.yml", "head_sha": self.commit,
               "run_attempt": 1}
        self.assertTrue(ci.valid_run(run, 42, self.commit))
        for key, value in (("head_sha", "d" * 40), ("run_attempt", 2),
                           ("head_branch", "other"), ("path", "other.yml"),
                           ("id", 43), ("event", "push")):
            self.assertFalse(ci.valid_run(dict(run, **{key: value}), 42, self.commit))
        self.assertFalse(ci.valid_run(run, 42, None))

    def test_dispatch_is_off_by_default(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(ci, "api") as api:
            with self.assertRaises(ValueError):
                ci.dispatch("example/private", self.commit)
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
