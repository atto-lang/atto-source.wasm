"""Adversarial regression tests for the identical cross-backend CI policy."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path("scripts/check_backend_private_ci_contract.py")
spec = importlib.util.spec_from_file_location("backend_private_ci_contract", SOURCE)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class BackendPrivateCIContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        folder = Path(self.tmp.name)
        self.manifest = folder / "contract.json"
        self.workflow = folder / "contract.yml"
        self.manifest.write_bytes(policy.MANIFEST.read_bytes())
        self.workflow.write_bytes(policy.WORKFLOW.read_bytes())
        cp = patch.object(policy, "MANIFEST", self.manifest)
        wp = patch.object(policy, "WORKFLOW", self.workflow)
        cp.start()
        wp.start()
        self.addCleanup(cp.stop)
        self.addCleanup(wp.stop)

    def test_every_backend_accepts_identical_valid_local_contract(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}):
            for backend in policy.IDS:
                with self.subTest(backend=backend):
                    self.assertTrue(policy.verify(backend))

    def test_source_transfer_must_fail_closed(self):
        initial = json.loads(self.manifest.read_text(encoding="utf-8"))
        for section, key, value in [
            ("source_transfer", "default_deny", False),
            ("source_transfer", "private_destination_only", False),
            ("source_transfer", "require_destination_approval_on_protected_source_main", False),
            ("source_transfer", "require_pinned_numeric_repo_ids", False),
            ("source_transfer", "require_exact_source_commit_and_complete_git_tree", False),
            ("source_transfer", "require_destination_blob_tree_commit_ref_attestation", False),
            ("source_transfer", "never_infer_approval_from_actions_minutes", False),
            ("validation_evidence", "runner_executed_steps_required", False),
            ("runtime_gate", "unsupported_features", "ignore_and_run"),
        ]:
            with self.subTest(setting=key):
                altered = json.loads(json.dumps(initial))
                altered[section][key] = value
                self.manifest.write_text(json.dumps(altered), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "invariants changed"):
                    policy.verify("llvm")
        self.manifest.write_text(json.dumps(initial), encoding="utf-8")

    def test_repo_id_or_unrecognized_backend_cannot_pass(self):
        data = json.loads(self.manifest.read_text(encoding="utf-8"))
        data["repository_ids"]["wasm"] = 123
        self.manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "identity or schema drift"):
            policy.verify("wasm")
        with self.assertRaisesRegex(ValueError, "unknown Oreslang backend"):
            policy.verify("unlisted")

    def test_workflow_must_not_elevate_or_persist_checkout_tokens(self):
        baseline = self.workflow.read_text(encoding="utf-8")
        for rewrite in [
            baseline.replace("contents: read", "contents: write"),
            baseline.replace("persist-credentials: false", "persist-credentials: true"),
            baseline.replace("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
                             "actions/checkout@v4"),
            baseline.replace("  pull_request:", "  pull_request_target:"),
            baseline.replace("python3 scripts/check_backend_private_ci_contract.py", "echo fake-green"),
        ]:
            with self.subTest(rewrite=rewrite[:90]):
                self.workflow.write_text(rewrite, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "(integrity|token|permissions|checkout|event|actually execute)"):
                    policy.verify("net")

    def test_commented_out_or_removed_execution_cannot_appear_green(self):
        baseline = self.workflow.read_text(encoding="utf-8")
        for obsolete in [
            baseline.replace(
                '          python3 scripts/check_backend_private_ci_contract.py --backend',
                '          # python3 scripts/check_backend_private_ci_contract.py --backend'),
            baseline.replace(
                '        run: python3 -m unittest discover -s tests -p test_guest_capability_admission.py -v',
                '        run: echo mocked-pass'),
            baseline.replace('  contents: read', '  contents: read\n# contents: write'),
            baseline.replace('  pull_request:', '  pull_request:\n  schedule:'),
        ]:
            with self.subTest(workflow=obsolete[-90:]):
                self.workflow.write_text(obsolete, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "workflow integrity"):
                    policy.verify("java")

    def test_github_actions_requires_pinned_private_repo_identity(self):
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": "attacker/oreslang-source.java",
            "GITHUB_REPOSITORY_ID": "1400792274",
            "GITHUB_EVENT_PATH": str(self.manifest),
        }):
            with self.assertRaisesRegex(ValueError, "repository slug"):
                policy.verify("java")
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": "ores-truffle-oreslang/oreslang-source.java",
            "GITHUB_REPOSITORY_ID": "1",
            "GITHUB_EVENT_PATH": str(self.manifest),
        }):
            with self.assertRaisesRegex(ValueError, "repository ID"):
                policy.verify("java")
        event = Path(self.tmp.name) / "event.json"
        event.write_text(json.dumps({"repository": {
            "full_name": "ores-truffle-oreslang/oreslang-source.java",
            "id": 1400792274, "private": False}}), encoding="utf-8")
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": "ores-truffle-oreslang/oreslang-source.java",
            "GITHUB_REPOSITORY_ID": "1400792274",
            "GITHUB_EVENT_PATH": str(event),
        }):
            with self.assertRaisesRegex(ValueError, "wrong/private-status"):
                policy.verify("java")


if __name__ == "__main__":
    unittest.main()
