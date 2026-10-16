#!/usr/bin/env python3
"""Adversarial tests for the report gate itself. Synthetic input is NEVER runtime proof."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_scoped_permissions as gate

COMMIT = "a" * 40
TREE = "b" * 40
VECTORS = Path(__file__).with_name("scoped-permissions-v1.json")


class ScopedPermissionGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.expected = gate.load_vectors(VECTORS)

    def report(self):
        return {
            "schema": gate.REPORT_SCHEMA,
            "backend": "llvm",
            "source_commit": COMMIT,
            "source_tree": TREE,
            "execution": {
                "runner": "SYNTHETIC UNIT TEST ONLY - NOT BACKEND EVIDENCE",
                "command": "SYNTHETIC UNIT TEST ONLY",
                "url": "https://github.com/placeholder/placeholder/actions/runs/1"
            },
            "results": [
                {"id": key, "decision": expected, "executed": True}
                for key, expected in self.expected.items()
            ]
        }

    def validate(self, report):
        return gate.validate_report(report, "llvm", self.expected, COMMIT, TREE)

    def modified_vectors(self, transform):
        with tempfile.TemporaryDirectory() as root:
            data = json.loads(VECTORS.read_text(encoding="utf-8"))
            transform(data)
            path = Path(root) / "vectors.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            return gate.load_vectors(path)

    def test_exact_corpus_and_backends(self):
        self.assertEqual(len(self.expected), 44)
        self.assertTrue({"default-read-denied", "coarse-ceiling-net",
                         "endpoint-deny-portless", "serialized-no-escalation"}
                        .issubset(self.expected))

    def test_synthetic_complete_report_only_exercises_gate(self):
        self.validate(self.report())  # Explicitly NOT actual guest execution.

    def test_missing_result_fails(self):
        report = self.report()
        report["results"].pop()
        with self.assertRaisesRegex(ValueError, "incomplete runtime"):
            self.validate(report)

    def test_duplicate_result_fails(self):
        report = self.report()
        report["results"][-1] = copy.deepcopy(report["results"][0])
        with self.assertRaisesRegex(ValueError, "unexpected/duplicate"):
            self.validate(report)

    def test_changed_decision_fails(self):
        report = self.report()
        item = report["results"][0]
        item["decision"] = "allow" if item["decision"] == "deny" else "deny"
        with self.assertRaisesRegex(ValueError, "permission mismatch"):
            self.validate(report)

    def test_skipped_or_synthetic_result_fails(self):
        for marker in [False, None, "true", 1]:
            report = self.report()
            report["results"][0]["executed"] = marker
            with self.assertRaisesRegex(ValueError, "skipped or synthetic"):
                self.validate(report)

    def test_invalid_result_shape_fails(self):
        report = self.report()
        report["results"][0] = None
        with self.assertRaisesRegex(ValueError, "runtime result must"):
            self.validate(report)

    def test_wrong_commit_or_tree_fails(self):
        for key in ["source_commit", "source_tree"]:
            report = self.report()
            report[key] = "f" * 40
            with self.assertRaisesRegex(ValueError, "commit/tree mismatch"):
                self.validate(report)

    def test_backend_or_missing_execution_fails(self):
        report = self.report()
        report["backend"] = "java"
        with self.assertRaisesRegex(ValueError, "backend report"):
            self.validate(report)
        report = self.report()
        report["execution"] = {}
        with self.assertRaisesRegex(ValueError, "execution metadata"):
            self.validate(report)

    def test_wrong_top_level_report_fails(self):
        with self.assertRaisesRegex(ValueError, "report must be"):
            self.validate(["not a report"])

    def test_nonobject_case_fails(self):
        with self.assertRaisesRegex(ValueError, "case must be an object"):
            self.modified_vectors(lambda data: data["cases"].__setitem__(0, None))

    def test_duplicate_case_identifier_fails(self):
        def mutate(data):
            data["cases"][1]["id"] = data["cases"][0]["id"]
        with self.assertRaisesRegex(ValueError, "duplicate case identifier"):
            self.modified_vectors(mutate)

    def test_missing_or_wrong_version_fails(self):
        for version in [None, True, 2]:
            with self.assertRaisesRegex(ValueError, "corpus schema"):
                self.modified_vectors(lambda data:
                    data.__setitem__("version", version))

    def test_missing_backend_fails(self):
        with self.assertRaisesRegex(ValueError, "backend coverage"):
            self.modified_vectors(lambda data: data["backends"].pop())

    def test_invalid_coarse_type_fails(self):
        with self.assertRaisesRegex(ValueError, "invalid authorization scope"):
            self.modified_vectors(lambda data:
                data["cases"][0].__setitem__("coarse", 1))

    def test_duplicated_json_key_fails(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "duplicate.json"
            path.write_text('{"schema":"x","schema":"y"}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
                gate.read_json(path)

    def test_symlinked_report_data_fails(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "target.json"
            target.write_text("{}", encoding="utf-8")
            link = Path(root) / "linked.json"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            with self.assertRaisesRegex(ValueError, "symlinked conformance"):
                gate.read_json(link)


if __name__ == "__main__":
    unittest.main()
