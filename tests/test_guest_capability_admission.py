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
                with patch.object(mod, "run_compiler_process", side_effect=fake_run):
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
        with patch.object(mod, "run_compiler_process", side_effect=always_accept):
            with self.assertRaisesRegex(RuntimeError, "ambient_filesystem"):
                mod.check("llvm", "mock-compiler")

    def test_accidental_rejection_of_supported_scalar_is_a_failure(self):
        def always_reject(argv, **kwargs):
            return type("Result", (), {"returncode": 1, "stdout": "",
                                         "stderr": "unsupported"})()
        with patch.object(mod, "run_compiler_process", side_effect=always_reject):
            with self.assertRaisesRegex(RuntimeError, "scalar_arithmetic_14"):
                mod.check("forge", "mock-compiler")

    def test_crashed_compiler_cannot_count_as_security_rejection(self):
        def crashed(argv, **kwargs):
            if any("scalar_arithmetic_14.ores" in part for part in argv):
                return type("Result", (), {"returncode": 0, "stdout": "verified IR",
                                             "stderr": ""})()
            return type("Result", (), {"returncode": -11, "stdout": "",
                                         "stderr": "segfault"})()
        with patch.object(mod, "run_compiler_process", side_effect=crashed):
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
            with patch.object(mod, "run_compiler_process", side_effect=fake_run):
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
                with patch.object(mod, "run_compiler_process", side_effect=fake_run):
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
                    with patch.object(mod, "run_compiler_process", side_effect=fake_run):
                        with self.assertRaisesRegex(RuntimeError, "ambient_filesystem"):
                            mod.check(backend, "mock-compiler")
                    self.assertEqual(len(attempts), 2)

    def test_missing_compiler_is_a_hard_failure(self):
        with patch.object(mod, "run_compiler_process", side_effect=FileNotFoundError("missing")):
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


    def test_strict_manifest_rejects_duplicate_and_unknown_keys(self):
        original = self.contract.read_text(encoding="utf-8")
        for mutant in (
            original.replace('"schema_version": 1,',
                             '"schema_version": 1, "schema_version": 1,', 1),
            original.replace('"bootstrap": "accept",',
                             '"bootstrap": "reject", "bootstrap": "accept",', 1),
            original.replace('"proof_scope":', '"unexpected": true, "proof_scope":', 1),
        ):
            with self.subTest(mutant=mutant[:80]):
                self.contract.write_text(mutant, encoding="utf-8")
                with self.assertRaises(ValueError):
                    mod.load_cases()
        self.contract.write_text(original, encoding="utf-8")

    def test_manifest_rejects_type_coercion_and_nonstandard_numbers(self):
        original = self.contract.read_text(encoding="utf-8")
        for mutant in (
            original.replace('"schema_version": 1,', '"schema_version": true,', 1),
            original.replace('"schema_version": 1,', '"schema_version": NaN,', 1),
            original.replace('"schema_version": 1,', '"schema_version": Infinity,', 1),
            original.replace('"schema_version": 1,', '"schema_version": {},', 1),
        ):
            with self.subTest(mutant=mutant[:80]):
                self.contract.write_text(mutant, encoding="utf-8")
                with self.assertRaises(ValueError):
                    mod.load_cases()
        self.contract.write_text(original, encoding="utf-8")

    def test_malformed_case_missing_id_is_controlled_rejection(self):
        original = json.loads(self.contract.read_text(encoding="utf-8"))
        del original["cases"][0]["id"]
        self.contract.write_text(json.dumps(original), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "incomplete guest admission case list"):
            mod.load_cases()

    def test_manifest_size_and_utf8_limits(self):
        self.contract.write_bytes(b" " * (128 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "size limit"):
            mod.load_cases()
        self.contract.write_bytes(b"\xff")
        with self.assertRaisesRegex(ValueError, "encoding"):
            mod.load_cases()


    @unittest.skipIf(os.name == "nt", "POSIX synthetic subprocess")
    def test_real_infinite_output_is_killed_before_disk_growth(self):
        compiler = Path(self.tmp.name) / "infinite-compiler"
        compiler.write_text(
            "#!/usr/bin/env python3\n"
            "import os\n"
            "while True: os.write(1, b'x' * 65536)\n", encoding="utf-8")
        compiler.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "output exceeds size limit"):
            mod.check("llvm", str(compiler), timeout=3)

    @unittest.skipIf(os.name == "nt", "POSIX synthetic subprocess")
    def test_real_infinite_stderr_is_killed_without_stdout_deadlock(self):
        compiler = Path(self.tmp.name) / "infinite-compiler-stderr"
        compiler.write_text(
            "#!/usr/bin/env python3\n"
            "import os\n"
            "while True: os.write(2, b'x' * 65536)\n", encoding="utf-8")
        compiler.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "output exceeds size limit"):
            mod.check("llvm", str(compiler), timeout=3)

    @unittest.skipIf(os.name == "nt", "POSIX synthetic subprocess")
    def test_real_hung_compiler_is_terminated(self):
        compiler = Path(self.tmp.name) / "hanging-compiler"
        compiler.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "time.sleep(30)\n", encoding="utf-8")
        compiler.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            mod.check("llvm", str(compiler), timeout=.2)

    @unittest.skipIf(os.name == "nt", "POSIX synthetic subprocess")
    def test_real_simultaneous_stdout_stderr_flood_does_not_deadlock(self):
        compiler = Path(self.tmp.name) / "dual-stream-compiler"
        compiler.write_text(
            "#!/usr/bin/env python3\n"
            "import os\n"
            "while True:\n"
            "    os.write(1, b'x' * 65536)\n"
            "    os.write(2, b'y' * 65536)\n", encoding="utf-8")
        compiler.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "output exceeds size limit"):
            mod.check("llvm", str(compiler), timeout=3)

    def test_reject_bounded_diagnostic_output_and_invalid_encoding(self):
        for reported, channel in (("x" * (mod.MAX_DIAGNOSTIC_BYTES + 1), "stdout"),
                                  (b"\xff", "stdout"),
                                  ("\x00", "stdout")):
            with self.subTest(channel=channel, type=type(reported).__name__, length=len(reported)):
                def fake_run(argv, **kwargs):
                    return type("Result", (), {"returncode": 0,
                        "stdout": reported, "stderr": ""})()
                with patch.object(mod, "run_compiler_process", side_effect=fake_run):
                    with self.assertRaisesRegex(RuntimeError, "compiler stdout"):
                        mod.check("llvm", "mock-compiler")

    def test_rejected_case_with_bad_diagnostic_cannot_fake_a_deny(self):
        attempts = []
        def fake_run(argv, **kwargs):
            attempts.append(argv)
            if len(attempts) == 1:
                return type("Result", (), {"returncode": 0, "stdout": "verified IR", "stderr": ""})()
            return type("Result", (), {"returncode": 1, "stdout": "", "stderr": b"\xff"})()
        with patch.object(mod, "run_compiler_process", side_effect=fake_run):
            with self.assertRaisesRegex(RuntimeError, "invalid compiler stderr encoding"):
                mod.check("llvm", "mock-compiler")
        self.assertEqual(len(attempts), 2)

    def test_bool_exit_code_does_not_impersonate_real_process_status(self):
        with patch.object(mod, "run_compiler_process", return_value=type("Result", (), {
                "returncode": True, "stdout": "", "stderr": "oreslang-llvmc: denied"})()):
            with self.assertRaisesRegex(RuntimeError, "unknown status"):
                mod.check("llvm", "mock-compiler")

    def test_compiler_timeout_rejects_bad_types_and_values(self):
        for invalid in (0, -1, 301, "60", True, None):
            with self.subTest(timeout=invalid):
                with self.assertRaisesRegex(ValueError, "timeout"):
                    mod.check("llvm", "mock-compiler", timeout=invalid)

    @unittest.skipIf(os.name == "nt", "requires POSIX executable Python test shim")
    def test_real_subprocess_streams_diagnostics_and_blocks_overflow(self):
        interpreter = Path(self.tmp.name) / "fake-oreslang-compiler"
        interpreter.write_text(
            "#!/usr/bin/env python3\n"
            "import os,sys\n"
            "name=os.path.basename(sys.argv[1])\n"
            "if name == 'scalar_arithmetic_14.ores':\n"
            "    print('define i64 @main() { ret i64 14 }')\n"
            "else:\n"
            "    print('oreslang-llvmc: unsupported guest source', file=sys.stderr)\n"
            "    sys.exit(1)\n", encoding="utf-8")
        interpreter.chmod(0o700)
        rows = mod.check("llvm", str(interpreter), timeout=3)
        self.assertEqual(len(rows), 9)
        interpreter.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "sys.stdout.write('X' * 1048577)\n", encoding="utf-8")
        interpreter.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "output exceeds size limit"):
            mod.check("llvm", str(interpreter), timeout=3)


    @unittest.skipIf(os.name == "nt", "POSIX compiler process tree regression")
    def test_exited_compiler_cannot_leave_background_child_holding_pipes(self):
        # The initial launcher exits immediately; a descendant retains both
        # output pipes. The test would otherwise hang past the deadline and
        # could let the child run after the admission check rejects the case.
        marker = Path(self.tmp.name) / "escaped-child-marker"
        started = Path(self.tmp.name) / "launcher-started"
        payload = ("from pathlib import Path; import time; time.sleep(2.0); "
                   + "Path(" + repr(str(marker)) + ").write_text('escaped')")
        fake = Path(self.tmp.name) / "forking-compiler"
        fake.write_text(
            "#!/usr/bin/env python3\n"
            "import subprocess, sys\n"
            "from pathlib import Path\n"
            "subprocess.Popen([sys.executable, '-c', " + repr(payload) + "], "
            "stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr)\n"
            "Path(" + repr(str(started)) + ").write_text('started')\n",
            encoding="utf-8")
        fake.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            mod.run_compiler_process([str(fake)], cwd=mod.ROOT, timeout=1.0,
                                     env=mod.sanitized_toolchain_environment())
        self.assertTrue(started.exists(),
                        "fixture launcher must have spawned a descendant")
        import time
        time.sleep(2.3)
        self.assertFalse(marker.exists(),
                         "timed-out compiler grandchild survived the process-group kill")

    @unittest.skipIf(os.name == "nt", "POSIX fake executable regression")
    def test_compiler_stdin_is_devnull_and_unrelated_file_descriptors_are_closed(self):
        fake = Path(self.tmp.name) / "stdin-checking-compiler"
        fake.write_text(
            "#!/usr/bin/env python3\n"
            "import os, sys\n"
            "if sys.stdin.buffer.read(1) != b'':\n"
            "    sys.exit(3)\n"
            "name=os.path.basename(sys.argv[1])\n"
            "if name == 'scalar_arithmetic_14.ores':\n"
            "    print('define i64 @main() { ret i64 14 }')\n"
            "else:\n"
            "    print('oreslang-llvmc: unsupported guest source', file=sys.stderr)\n"
            "    sys.exit(1)\n", encoding="utf-8")
        fake.chmod(0o700)
        original_popen = mod.subprocess.Popen
        with patch.object(mod.subprocess, "Popen", wraps=original_popen) as launch:
            rows = mod.check("llvm", str(fake), timeout=3)
        self.assertEqual(len(rows), 9)
        self.assertEqual(launch.call_count, 9)
        for args, kwargs in launch.call_args_list:
            self.assertIs(kwargs.get("stdin"), mod.subprocess.DEVNULL)
            self.assertIs(kwargs.get("close_fds"), True)


if __name__ == "__main__":
    unittest.main()
