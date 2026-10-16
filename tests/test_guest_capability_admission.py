"""Control-flow tests for the compiler-backed admission harness.

These tests use mocked compiler statuses and are NOT guest compiler evidence.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path("scripts/check_guest_capability_admission.py")
spec = importlib.util.spec_from_file_location("guest_admission", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class GuestAdmissionHarnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.contract = Path(self.tmp.name) / "admission.json"
        self.contract.write_bytes(mod.CONTRACT.read_bytes())
        mocked = patch.object(mod, "CONTRACT", self.contract)
        mocked.start()
        self.addCleanup(mocked.stop)

    def test_unsupported_backends_never_report_parity(self):
        for backend in ("java", "wasm"):
            with self.subTest(backend=backend):
                with self.assertRaisesRegex(ValueError, "no executable source-compiler adapter"):
                    mod.check(backend)
        self.assertEqual(set(mod.COMMANDS), {"llvm", "net", "forge"})

    def test_all_compiler_adapters_must_observe_exact_admission(self):
        cases = mod.load_cases()
        for backend in ("llvm", "net", "forge"):
            with self.subTest(backend=backend):
                calls = []
                def fake_run(argv, **kwargs):
                    calls.append(argv)
                    idx = len(calls) - 1
                    success = idx == 0
                    marker = "Oreslang subset syntax and typed OresIR: OK" if backend == "net" else "verified IR"
                    return type("Result", (), {
                        "returncode": 0 if success else 1,
                        "stdout": marker if success else "",
                        "stderr": "" if success else mod.REJECTION_PREFIXES[backend] + " unsupported guest capability"
                    })()
                with patch.object(mod.subprocess, "run", side_effect=fake_run):
                    rows = mod.check(backend, "mock-compiler", timeout=3)
                self.assertEqual(len(rows), len(cases))
                self.assertEqual([v[1] for v in rows], ["accept"] + ["reject"] * 8)
                self.assertEqual(len(calls), 9)
                self.assertFalse(any("run" in argv and backend != "net" for argv in calls))
                if backend == "net":
                    self.assertTrue(all("check" in argv for argv in calls))
                if backend == "forge":
                    self.assertTrue(all("ir" in argv for argv in calls))

    def test_accidental_acceptance_is_always_a_failure(self):
        def always_accept(argv, **kwargs):
            return type("Result", (), {"returncode": 0, "stdout": "verified IR",
                                         "stderr": ""})()
        with patch.object(mod.subprocess, "run", side_effect=always_accept):
            with self.assertRaisesRegex(RuntimeError, "ambient_filesystem"):
                mod.check("llvm", "mock-compiler")

    def test_accidental_rejection_of_supported_scalar_is_a_failure(self):
        def always_reject(argv, **kwargs):
            return type("Result", (), {"returncode": 1, "stdout": "",
                                         "stderr": "unsupported"})()
        with patch.object(mod.subprocess, "run", side_effect=always_reject):
            with self.assertRaisesRegex(RuntimeError, "scalar_arithmetic_14"):
                mod.check("forge", "mock-compiler")

    def test_crashed_compiler_cannot_count_as_security_rejection(self):
        def crashed(argv, **kwargs):
            if any("scalar_arithmetic_14.ores" in part for part in argv):
                return type("Result", (), {"returncode": 0, "stdout": "verified IR",
                                             "stderr": ""})()
            return type("Result", (), {"returncode": -11, "stdout": "",
                                         "stderr": "segfault"})()
        with patch.object(mod.subprocess, "run", side_effect=crashed):
            with self.assertRaisesRegex(RuntimeError, "compiler crashed"):
                mod.check("llvm", "mock-compiler")

    def test_ci_secrets_are_never_inherited_by_compiler(self):
        captured = []
        def fake_run(argv, **kwargs):
            captured.append(kwargs.get("env", {}))
            accepted = len(captured) == 1
            return type("Result", (), {"returncode": 0 if accepted else 1,
                        "stdout": "verified IR" if accepted else "",
                        "stderr": mod.REJECTION_PREFIXES["llvm"] + " unsupported" if not accepted else ""})()
        with patch.dict(os.environ, {
            "GITHUB_TOKEN": "should-not-leak",
            "AWS_SECRET_ACCESS_KEY": "should-not-leak",
            "PATH": "/bin",
            "DOTNET_ROOT": "/opt/dotnet",
        }):
            with patch.object(mod.subprocess, "run", side_effect=fake_run):
                mod.check("llvm", "mock-compiler")
        self.assertEqual(len(captured), 9)
        for env in captured:
            self.assertNotIn("GITHUB_TOKEN", env)
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
            self.assertEqual(env.get("PATH"), "/bin")
            self.assertEqual(env.get("DOTNET_ROOT"), "/opt/dotnet")

    def test_rejected_source_cannot_emit_partial_ir(self):
        for backend in ("llvm", "forge"):
            with self.subTest(backend=backend):
                attempts = []
                def fake_run(argv, **kwargs):
                    attempts.append(argv)
                    if len(attempts) == 1:
                        return type("Result", (), {
                            "returncode": 0, "stdout": "verified IR", "stderr": ""})()
                    return type("Result", (), {
                        "returncode": 1, "stdout": "define i64 @main() { }",
                        "stderr": mod.REJECTION_PREFIXES[backend] + " unsupported"})()
                with patch.object(mod.subprocess, "run", side_effect=fake_run):
                    with self.assertRaisesRegex(RuntimeError, "partial compiler IR"):
                        mod.check(backend, "mock-compiler")
                self.assertEqual(len(attempts), 2)

    def test_usage_and_build_failure_are_not_capability_rejection(self):
        for backend in ("llvm", "forge", "net"):
            for status, diagnostic in (
                (2, "usage: wrong invocation"),
                (1, "error: SDK or linker unavailable"),
                (1, ""),
            ):
                with self.subTest(backend=backend, status=status,
                                  diagnostic=diagnostic):
                    attempts = []
                    def fake_run(argv, **kwargs):
                        attempts.append(argv)
                        if len(attempts) == 1:
                            output = ("Oreslang subset syntax and typed OresIR: OK"
                                      if backend == "net" else "verified IR")
                            return type("Result", (), {
                                "returncode": 0, "stdout": output, "stderr": ""})()
                        return type("Result", (), {
                            "returncode": status,
                            "stdout": "", "stderr": diagnostic})()
                    with patch.object(mod.subprocess, "run", side_effect=fake_run):
                        with self.assertRaisesRegex(RuntimeError, "ambient_filesystem"):
                            mod.check(backend, "mock-compiler")
                    self.assertEqual(len(attempts), 2)

    def test_missing_compiler_is_a_hard_failure(self):
        with patch.object(mod.subprocess, "run", side_effect=FileNotFoundError("missing")):
            with self.assertRaisesRegex(RuntimeError, "compiler unavailable"):
                mod.check("llvm", "absent")

    def test_manifest_cannot_silently_drop_cases_or_change_expectations(self):
        source = json.loads(self.contract.read_text(encoding="utf-8"))
        for mutation in ("drop-case", "accept-network", "change-proof-scope", "mutate-source", "change-category", "inject-field"):
            data = copy.deepcopy(source)
            if mutation == "drop-case":
                data["cases"].pop()
            elif mutation == "accept-network":
                data["cases"][2]["bootstrap"] = "accept"
            elif mutation == "mutate-source":
                data["cases"][1]["source"] = "pub fnc main(): int { return invalid; }"
            elif mutation == "change-category":
                data["cases"][1]["category"] = "scalar"
            elif mutation == "inject-field":
                data["cases"][1]["skip_backend"] = "forge"
            else:
                data["proof_scope"] = "runtime-security-proven"
            self.contract.write_text(json.dumps(data), encoding="utf-8")
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValueError):
                    mod.load_cases()


if __name__ == "__main__":
    unittest.main()
