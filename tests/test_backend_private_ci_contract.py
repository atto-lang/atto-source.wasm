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


    def test_yaml_parses_to_reviewed_workflow_structure(self):
        self.assertEqual(
            policy.parse_strict_workflow_yaml(self.workflow.read_text(encoding="utf-8")),
            policy.EXPECTED_WORKFLOW)

    def test_structural_adversaries_rejected_even_with_updated_hash(self):
        original = self.workflow.read_text(encoding="utf-8")
        variants = [
            original + "\non:\n",
            original.replace("  contents: read", "  contents: read\n  contents: write"),
            original.replace("          persist-credentials: false",
                             "          persist-credentials: false\n          persist-credentials: true"),
            original.replace("        uses: actions/checkout@",
                             "        name: fake\n        uses: actions/checkout@"),
            original.replace("  pull_request:", "  pull_request_target:"),
            original.replace("  pull_request:", "  workflow_run:"),
            original.replace("  workflow_dispatch:", "  repository_dispatch:"),
            original.replace("contents: read", "contents: write"),
            original.replace("  contents: read", "  contents: read\n  actions: write"),
            original.replace("    runs-on:", "    permissions:\n      contents: write\n    runs-on:"),
            original.replace("    timeout-minutes: 5", "    timeout-minutes: 0"),
            original + "\n  exfiltrate:\n    runs-on: ubuntu-latest\n",
            original.replace("  policy-parity:", "  policy-parity:\n    if: always()"),
            original.replace("    steps:", "    container: ubuntu:latest\n    steps:"),
            original.replace("    steps:", "    steps:\n      - name: Unreviewed\n        run: curl https://example.org"),
            original.replace("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
                             "actions/checkout@v4"),
            original.replace("persist-credentials: false", "persist-credentials: true"),
            original.replace("persist-credentials: false",
                             "persist-credentials: false\n          repository: attacker/repo"),
            original.replace("python3 scripts/check_backend_private_ci_contract.py",
                             "echo fake-green"),
            original.replace("python3 -m unittest discover -s tests -p test_guest_capability_admission.py -v",
                             "echo fake-green"),
            original.replace("        run: |", "        run: >"),
            original.replace("on:", '"on":', 1),
            original.replace("on:", "on: &event", 1),
            original.replace("on:", "on: *event", 1),
            original.replace("on:", "on: !!map", 1),
            original.replace("on:", "on: {push: {}}", 1),
            original.replace("  push:", "  <<: *defaults\n  push:"),
            original.replace("  contents: read", "  contents:\tread"),
            "---\n" + original,
            original + "\n...\n",
            original.replace("  contents: read", "   contents: read"),
        ]
        for text in variants:
            with self.subTest(case=text[:80]):
                self.assertNotEqual(original, text)
                self.workflow.write_text(text, encoding="utf-8")
                with patch.object(policy, "WORKFLOW_SHA256",
                                  __import__("hashlib").sha256(text.encode()).hexdigest()):
                    with self.assertRaisesRegex(ValueError, "workflow integrity"):
                        policy.verify("java")
        self.workflow.write_text(original, encoding="utf-8")

    def test_comment_only_change_still_requires_workflow_review(self):
        original = self.workflow.read_text(encoding="utf-8")
        modified = original + "# unreviewed change\n"
        self.assertEqual(policy.parse_strict_workflow_yaml(modified),
                         policy.EXPECTED_WORKFLOW)
        with self.assertRaisesRegex(ValueError, "workflow integrity"):
            policy.validate_workflow(modified)


    def test_duplicate_manifest_keys_rejected(self):
        original = self.manifest.read_text(encoding="utf-8")
        self.manifest.write_text(original.replace(
            '"schema_version": 1,', '"schema_version": 1, "schema_version": 1,', 1),
            encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate security JSON key"):
            policy.verify("java")

    def test_nested_duplicate_manifest_keys_rejected(self):
        original = self.manifest.read_text(encoding="utf-8")
        self.manifest.write_text(original.replace(
            '"default_deny": true,', '"default_deny": false, "default_deny": true,', 1),
            encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate security JSON key"):
            policy.verify("java")

    def test_manifest_schema_version_cannot_be_boolean(self):
        original = self.manifest.read_text(encoding="utf-8")
        self.manifest.write_text(original.replace(
            '"schema_version": 1,', '"schema_version": true,', 1),
            encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "schema drift"):
            policy.verify("java")

    def test_manifest_rejects_nonstandard_json_numbers(self):
        original = self.manifest.read_text(encoding="utf-8")
        self.manifest.write_text(original.replace(
            '"schema_version": 1,', '"schema_version": NaN,', 1),
            encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "nonstandard security JSON"):
            policy.verify("java")

    def test_json_loader_bounds_input(self):
        with self.assertRaisesRegex(ValueError, "size limit"):
            policy.strict_json_document(self.manifest, limit=8)

    def test_duplicate_github_event_keys_rejected(self):
        event = self.manifest.parent / "event.json"
        event.write_text('{"repository":{"id":1400792274,"id":1400792274, '
                         '"full_name":"ores-truffle-oreslang/oreslang-source.java",'
                         '"private":true}}', encoding="utf-8")
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": "ores-truffle-oreslang/oreslang-source.java",
            "GITHUB_REPOSITORY_ID": "1400792274",
            "GITHUB_EVENT_PATH": str(event),
        }):
            with self.assertRaisesRegex(ValueError, "duplicate security JSON key"):
                policy.verify("java")


    def test_numeric_values_cannot_impersonate_boolean_policy(self):
        original = self.manifest.read_text(encoding="utf-8")
        self.manifest.write_text(original.replace(
            '"default_deny": true,', '"default_deny": 1,', 1), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "invariants changed"):
            policy.verify("java")


    def _verify_github_event(self, backend, event_name, ref, event):
        event_file = Path(self.tmp.name) / "github-event.json"
        event_file.write_text(json.dumps(event), encoding="utf-8")
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": "ores-truffle-oreslang/oreslang-source." + backend,
            "GITHUB_REPOSITORY_ID": str(policy.IDS[backend]),
            "GITHUB_EVENT_NAME": event_name,
            "GITHUB_REF": ref,
            "GITHUB_EVENT_PATH": str(event_file),
        }):
            return policy.verify(backend)

    @staticmethod
    def _repo_event(backend):
        return {"full_name": "ores-truffle-oreslang/oreslang-source." + backend,
                "id": policy.IDS[backend], "private": True}

    def test_all_backends_bind_push_to_protected_main(self):
        for backend in policy.IDS:
            with self.subTest(backend=backend):
                event = {"repository": self._repo_event(backend),
                         "ref": "refs/heads/main"}
                self.assertTrue(self._verify_github_event(
                    backend, "push", "refs/heads/main", event))

    def test_same_repository_pull_request_event_is_valid(self):
        for backend in policy.IDS:
            with self.subTest(backend=backend):
                repo = self._repo_event(backend)
                event = {"repository": repo, "pull_request": {
                    "number": 42,
                    "head": {"repo": dict(repo)},
                    "base": {"repo": dict(repo)}}}
                self.assertTrue(self._verify_github_event(
                    backend, "pull_request", "refs/pull/42/merge", event))

    def test_fork_or_changed_pull_request_repository_is_denied(self):
        repo = self._repo_event("llvm")
        for part, change in (
            ("head", {"id": 99}),
            ("head", {"full_name": "untrusted/oreslang-source.llvm"}),
            ("head", {"private": False}),
            ("base", {"id": True}),
            ("base", {"id": 99}),
            ("base", {"private": False}),
        ):
            with self.subTest(part=part, change=change):
                event = {"repository": dict(repo), "pull_request": {
                    "number": 42,
                    "head": {"repo": dict(repo)},
                    "base": {"repo": dict(repo)}}}
                event["pull_request"][part]["repo"].update(change)
                with self.assertRaisesRegex(ValueError,
                                            "foreign or unverifiable pull request"):
                    self._verify_github_event(
                        "llvm", "pull_request", "refs/pull/42/merge", event)

    def test_untrusted_ci_events_or_refs_are_denied(self):
        repo = self._repo_event("forge")
        for name, ref, event in (
            ("workflow_run", "refs/heads/main",
             {"repository": repo, "ref": "refs/heads/main"}),
            ("pull_request_target", "refs/pull/42/merge",
             {"repository": repo}),
            ("push", "refs/heads/topic",
             {"repository": repo, "ref": "refs/heads/topic"}),
            ("workflow_dispatch", "refs/heads/topic",
             {"repository": repo, "ref": "topic"}),
            ("workflow_dispatch", "refs/heads/main",
             {"repository": repo, "ref": "topic"}),
        ):
            with self.subTest(name=name, ref=ref):
                with self.assertRaises(ValueError):
                    self._verify_github_event("forge", name, ref, event)

    def test_pr_number_malformed_or_unbound_ref_is_denied(self):
        repo = self._repo_event("net")
        for number, ref in ((True, "refs/pull/1/merge"),
                            (0, "refs/pull/0/merge"),
                            (1.0, "refs/pull/1/merge"),
                            (42, "refs/pull/41/merge"),
                            (42, "refs/heads/main")):
            with self.subTest(number=number, ref=ref):
                event = {"repository": repo, "pull_request": {
                    "number": number, "head": {"repo": dict(repo)},
                    "base": {"repo": dict(repo)}}}
                with self.assertRaises(ValueError):
                    self._verify_github_event("net", "pull_request", ref, event)

    def test_workflow_dispatch_only_allows_main(self):
        repo = self._repo_event("wasm")
        for event_ref in ("main", "refs/heads/main"):
            self.assertTrue(self._verify_github_event(
                "wasm", "workflow_dispatch", "refs/heads/main",
                {"repository": repo, "ref": event_ref}))


if __name__ == "__main__":
    unittest.main()
