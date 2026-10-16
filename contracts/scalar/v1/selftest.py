#!/usr/bin/env python3
"""Adversarial tests for the shared scalar conformance runner (no compiler required)."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
RUN = ROOT / "run.py"
SPEC = importlib.util.spec_from_file_location("ores_scalar_gate", RUN)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
CANONICAL_SUITE_SHA256 = "4ca1512bbcab67d5af3f5db0665d139c802dd4cbbff048a3004c214d60bf3eb5"


class ScalarHarnessTest(unittest.TestCase):
    def setUp(self):
        self.original = runner.HERE
        self.tmp = tempfile.TemporaryDirectory(prefix="ores-scalar-audit-")
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: setattr(runner, "HERE", self.original))
        runner.HERE = Path(self.tmp.name)
        (runner.HERE / "fixtures").mkdir()
        shutil.copy2(ROOT / "cases.json", runner.HERE / "cases.json")
        for case in json.loads((ROOT / "cases.json").read_text())["cases"]:
            src = ROOT / case["file"]
            shutil.copy2(src, runner.HERE / case["file"])

    def case_data(self):
        return json.loads((runner.HERE / "cases.json").read_text())

    def write(self, value):
        (runner.HERE / "cases.json").write_text(json.dumps(value) + "\n")

    def test_canonical_digest_and_inventory(self):
        suite, digest = runner.load_suite()
        self.assertEqual(digest, CANONICAL_SUITE_SHA256)
        self.assertEqual(len(suite["cases"]), 10)

    def test_non_object_manifest_or_entry_denied(self):
        for bad in [[], None, {"schema_version": "1.0.0", "cases": [None]},
                    {"schema_version": "1.0.0", "cases": [42]}]:
            with self.subTest(bad=bad):
                self.write(bad)
                with self.assertRaises(ValueError):
                    runner.load_suite()

    def test_duplicate_fixture_path_denied(self):
        suite = self.case_data()
        suite["cases"][1]["file"] = suite["cases"][0]["file"]
        self.write(suite)
        with self.assertRaisesRegex(ValueError, "duplicate source fixture"):
            runner.load_suite()

    def test_wrong_expected_value_or_extra_field_denied(self):
        suite = self.case_data()
        suite["cases"][0]["value"] = "9223372036854775808"
        self.write(suite)
        with self.assertRaisesRegex(ValueError, "outside range"):
            runner.load_suite()
        suite = self.case_data()
        suite["cases"][0]["extra"] = 1
        self.write(suite)
        with self.assertRaisesRegex(ValueError, "unexpected case fields"):
            runner.load_suite()

    def test_symlink_fixture_path_denied(self):
        path = runner.HERE / "fixtures" / "literal-42.ores"
        path.unlink()
        try:
            path.symlink_to(ROOT / "fixtures" / "literal-42.ores")
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation not permitted on this platform")
        with self.assertRaisesRegex(ValueError, "fixture path escapes"):
            runner.load_suite()

    def test_false_success_and_missing_compiler_denied(self):
        source = runner.HERE / "fixtures" / "literal-42.ores"
        missing = runner.run_case([str(runner.HERE / "missing-tool")], source, "accept", "42", "stdout-i64", 2)
        self.assertFalse(missing[0])
        false_success = runner.run_case([sys.executable, "-c", "pass"], source,
                                        "accept", "42", "stdout-i64", 2)
        self.assertFalse(false_success[0])
        wrong_status = runner.run_case([sys.executable, "-c", "import sys;sys.exit(2)"],
                                       source, "reject", None, "admission", 2)
        self.assertFalse(wrong_status[0])
        valid_exit = runner.run_case([sys.executable, "-c", "print(42)"], source,
                                     "accept", "42", "stdout-i64", 2)
        self.assertTrue(valid_exit[0], valid_exit[1])
        crash = runner.run_case([sys.executable, "-c", "import sys;sys.exit(3)"],
                                source, "reject", None, "admission", 2)
        self.assertFalse(crash[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
