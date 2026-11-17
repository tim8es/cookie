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

    def test_worker_env_excludes_tokens_and_output_channels(self):
        with patch.dict(os.environ, {"PATH": "/usr/bin", "CI_EVIDENCE_TOKEN": "fake",
                                    "TASK_RUNNER_ACCESS_TOKEN": "fake", "GITHUB_OUTPUT": "/fake",
                                    "ACTIONS_RUNTIME_TOKEN": "fake"}, clear=True):
            self.assertEqual(ci.worker_env(), {"PATH": "/usr/bin", "CI": "true"})

    def test_dispatch_is_off_by_default(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(ci, "api") as api:
            with self.assertRaises(ValueError):
                ci.dispatch("example/private", self.commit)
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
