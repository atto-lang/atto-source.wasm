#!/usr/bin/env python3
"""Self-tests for the Option admission harness (synthetic compilers only).

These tests check the verifier's fail-closed behavior, not Oreslang semantics.
Only the CI build's actual compiler invocation can provide admission evidence.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "check_option_pattern_contract.py"
MANIFEST = ROOT / "contracts" / "v1" / "option-pattern-v1.json"


class OptionPatternHarnessTest(unittest.TestCase):
    def command(self, *args):
        return subprocess.run(
            [sys.executable, str(RUNNER), *args],
            capture_output=True, text=True, timeout=30, check=False)

    def test_manifest_inventory_is_exact(self):
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual("oreslang.option-if-matches.v1", data["suite"])
        self.assertEqual(9, len(data["cases"]))
        self.assertEqual(9, len({case["id"] for case in data["cases"]}))
        self.assertEqual(5, len(data["status_contract"]))
        self.assertIn("reference", data["cases"][0])

    def test_wasm_is_never_claimed_as_independent_compiler(self):
        result = self.command("--backend", "wasm")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("PENDING_NO_COMPILER_EXECUTION", result.stdout)
        refused = self.command("--backend", "wasm", "--", "fake-compiler", "{source}")
        self.assertNotEqual(0, refused.returncode)

    def test_missing_native_compiler_cannot_pass(self):
        missing = self.command("--backend", "llvm")
        self.assertNotEqual(0, missing.returncode)
        self.assertIn("FAIL_CLOSED", missing.stderr)

    def test_always_failing_compiler_does_not_count_as_unsupported_admission(self):
        with tempfile.TemporaryDirectory() as root:
            fake = Path(root) / "always_fails.py"
            fake.write_text("import sys\nsys.exit(1)\n", encoding="utf-8")
            result = self.command("--backend", "llvm", "--",
                                  sys.executable, str(fake), "{source}")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("basic scalar control", result.stderr)

    def test_synthetic_backend_rejection_is_labeled_not_parity(self):
        with tempfile.TemporaryDirectory() as root:
            fake = Path(root) / "synthetic.py"
            fake.write_text(
                "from pathlib import Path\n"
                "import sys\n"
                "s = Path(sys.argv[1]).read_text(encoding='utf-8')\n"
                "sys.exit(0 if 'main(): int { return 42; }' in s else 1)\n",
                encoding="utf-8")
            report = Path(root) / "report.json"
            result = self.command(
                "--backend", "forge", "--report", str(report), "--",
                sys.executable, str(fake), "{source}")
            self.assertEqual(0, result.returncode, result.stderr)
            data = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual("unsupported_syntax_rejected_not_parity", data["status"])
            self.assertEqual(9, len(data["cases"]))
            self.assertTrue(all(c["verified"] for c in data["cases"]))

    def test_partial_llvm_ir_on_error_cannot_pass(self):
        with tempfile.TemporaryDirectory() as root:
            fake = Path(root) / "partial_ir.py"
            fake.write_text(
                "from pathlib import Path\n"
                "import sys\n"
                "s = Path(sys.argv[1]).read_text(encoding='utf-8')\n"
                "if 'main(): int { return 42; }' in s: sys.exit(0)\n"
                "print('define i64 @main() {')\n"
                "sys.exit(1)\n", encoding="utf-8")
            result = self.command("--backend", "llvm", "--",
                                  sys.executable, str(fake), "{source}")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("status=failed", result.stdout)


if __name__ == "__main__":
    unittest.main()
