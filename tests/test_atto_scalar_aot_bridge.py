"""Source-free refusal-path tests; no real AttoLang compiler is involved."""
import hashlib
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "tools/atto_scalar_aot.py"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ScalarBridgeNegatives(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = pathlib.Path(self.tmp.name)
        self.source = self.work / "program.atto"
        self.source.write_text("pub fnc main(): int { return 7; }\n")
        self.tool = self.work / "dummy-compiler"
        self.tool.write_text("#!/bin/sh\nprintf 'untrusted fake compiler output'\n")
        self.tool.chmod(0o755)
        self.out = self.work / "out"

    def run_gate(self, extra=(), source=None, digest=None, tool=None, compiler_sha=None):
        source = source or self.source
        tool = tool or self.tool
        args = [
            sys.executable, str(BRIDGE), str(source),
            "--source-sha256", digest or sha(self.source),
            "--compiler", str(tool), "--compiler-sha256", compiler_sha or sha(self.tool),
            "--precompiler", str(self.tool), "--precompiler-sha256", sha(self.tool),
            "--wasm-clang", str(self.tool), "--wasm-ld", str(self.tool),
            "--out", str(self.out), *extra,
        ]
        return subprocess.run(args, text=True, capture_output=True, timeout=15)

    def denied(self, result, reason):
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("ATTO_SCALAR_AOT_NOT_EXECUTED", result.stderr)
        self.assertIn(reason, result.stderr)
        self.assertFalse(self.out.exists(), "failed gate published an AOT artifact")

    def test_denies_non_atto_input(self):
        alt = self.work / "fake.ll"
        alt.write_bytes(self.source.read_bytes())
        self.denied(self.run_gate(source=alt), "only actual .atto")

    def test_denies_wrong_source_digest(self):
        self.denied(self.run_gate(digest="0"*64), "source.atto" if False else "input SHA256")

    def test_denies_missing_compiler(self):
        self.denied(self.run_gate(tool=self.work / "missing-tool"), "missing or nonexecutable tool")

    def test_denies_compiler_digest_mismatch(self):
        self.denied(self.run_gate(compiler_sha="f"*64), "input SHA256")

    def test_denies_unrecognized_llvm_ir_before_aot(self):
        self.denied(self.run_gate(), "LLVM compiler emitted no wasm32 main IR")

    def test_denies_missing_debug_runner_digest(self):
        self.denied(self.run_gate(extra=("--debug-runner", str(self.tool))), "debug runner and digest")

    def test_denies_debug_expected_scalar_without_runner(self):
        self.denied(self.run_gate(extra=("--expect-scalar", "7")), "expected observed scalar")

    def test_denies_symlinked_source(self):
        link = self.work / "symlink.atto"
        link.symlink_to(self.source)
        self.denied(self.run_gate(source=link), "missing, nonregular or symlinked input")

    def test_denies_nonexecutable_compiler(self):
        self.tool.chmod(0o644)
        self.denied(self.run_gate(), "missing or nonexecutable tool")

    def test_denies_existing_output_directory(self):
        self.out.mkdir()
        result = self.run_gate()
        self.assertEqual(result.returncode, 2)
        self.assertIn("output directory already exists", result.stderr)
        self.assertEqual(list(self.out.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
