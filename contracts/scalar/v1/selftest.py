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
CANONICAL_SUITE_SHA256 = "5b5d1bc00def9b3a343cb3281e0bb0be4e5ca438095f621141049e2d7a1a25b3"


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
        self.assertEqual(len(suite["cases"]), 11)

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

    def test_fifo_source_refused_before_open(self):
        if not hasattr(__import__("os"), "mkfifo"):
            self.skipTest("named pipes are not supported on this platform")
        import os
        path = runner.HERE / "fixtures" / "literal-42.ores"
        path.unlink()
        try:
            os.mkfifo(path)
        except OSError:
            self.skipTest("named-pipe creation unavailable")
        with self.assertRaisesRegex(ValueError, "unique regular file"):
            runner.load_suite()

    def test_directory_in_place_of_source_is_rejected(self):
        path = runner.HERE / "fixtures" / "literal-42.ores"
        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(ValueError, "unique regular file"):
            runner.load_suite()

    def test_oversized_sparse_source_rejected_before_read(self):
        path = runner.HERE / "fixtures" / "literal-42.ores"
        with path.open("wb") as stream:
            stream.truncate(runner.MAX_FIXTURE_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "invalid source length"):
            runner.load_suite()

    def test_hardlinked_fixture_cannot_alias_other_source(self):
        import os
        path = runner.HERE / "fixtures" / "literal-42.ores"
        other = runner.HERE / "fixture-alias"
        try:
            os.link(path, other)
        except OSError:
            self.skipTest("hardlinks unavailable")
        with self.assertRaisesRegex(ValueError, "unique regular file"):
            runner.load_suite()

    def test_substituted_open_file_descriptor_rejected(self):
        import os
        from unittest.mock import patch
        path = runner.HERE / "fixtures" / "literal-42.ores"
        other = runner.HERE / "another-fixture.ores"
        other.write_bytes(path.read_bytes())
        real_open = os.open
        def substituted_open(filename, flags):
            if str(filename) == str(path):
                return real_open(other, flags)
            return real_open(filename, flags)
        with patch.object(runner.os, "open", side_effect=substituted_open):
            with self.assertRaisesRegex(ValueError, "fixture changed before read"):
                runner.load_suite()

    def test_published_report_requires_exact_source_revision(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from unittest.mock import patch

        report = runner.HERE / "scalar-report.json"
        argv = [
            "run.py", "--backend", "forge", "--mode", "stdout-i64",
            "--command", "nonexistent-compiler {source}",
            "--report", str(report)
        ]
        with patch.object(sys, "argv", argv):
            with redirect_stderr(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as thrown:
                    runner.main()
        self.assertEqual(thrown.exception.code, 2)
        self.assertIn("--report requires --revision", output.getvalue())
        self.assertFalse(report.exists())

        # A source revision is a declaration, not a compiler provenance proof.
        # Mocked execution tests reporting only, not guest execution.
        with patch.object(sys, "argv", argv + ["--revision", "a" * 40]):
            with patch.object(runner, "run_case", return_value=(True, "mock-only")):
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(runner.main(), 0)
        data = json.loads(report.read_text())
        self.assertEqual(data["source_revision"], "a" * 40)
        self.assertEqual(data["evidence_level"], "source-executed-scalar")
        self.assertEqual(len(data["results"]), 11)

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
