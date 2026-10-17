#!/usr/bin/env python3
"""Mutation tests for the actor-hook parity contract's fail-closed verifier."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "verify_private_abstract_actor_hook_v1.py"
MANIFEST_PATH = HERE / "private-abstract-actor-hook-v1.json"
spec = importlib.util.spec_from_file_location("private_abstract_actor_verifier", MODULE_PATH)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class PrivateAbstractActorHookContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def fail_mutation(self, mutate):
        altered = copy.deepcopy(self.original)
        mutate(altered)
        with self.assertRaises(verifier.ContractError):
            verifier.validate(altered)

    def test_normative_corpus_is_consistent_but_not_executable_proof(self):
        result = verifier.validate(self.original)
        self.assertEqual(result["vectors"], 12)
        self.assertEqual(result["backend_count"], 5)
        self.assertFalse(result["compiler_executed"])
        self.assertFalse(result["parity_proven"])

    def test_missing_backend_fails_closed(self):
        self.fail_mutation(lambda d: d["backend_capabilities"].pop("forge"))

    def test_unsupported_backend_cannot_promote_its_claim(self):
        self.fail_mutation(lambda d: d["backend_capabilities"]["net"].update(status="supported"))

    def test_unreviewed_private_mirror_rule_cannot_disappear(self):
        self.fail_mutation(lambda d: d["rules"].remove("protected_approval_before_private_mirror"))

    def test_duplicate_source_vector_fails_closed(self):
        self.fail_mutation(lambda d: d["vectors"].__setitem__(1, copy.deepcopy(d["vectors"][0])))

    def test_negative_actor_direct_call_cannot_be_labeled_accepted(self):
        self.fail_mutation(lambda d: d["vectors"][9].update(expected="accept"))

    def test_actor_self_arity_fixture_must_remain_explicit(self):
        self.fail_mutation(lambda d: d["vectors"][6].update(source="define actor Worker as end"))

    def test_blank_diagnostic_classification_is_rejected(self):
        self.fail_mutation(lambda d: d["vectors"][4].update(diagnostic=" "))

    def test_missing_source_is_rejected(self):
        self.fail_mutation(lambda d: d["vectors"][3].update(source=""))

    def test_duplicate_rule_is_rejected(self):
        self.fail_mutation(lambda d: d["rules"].append("deny_direct_receive"))

    def test_cli_cannot_claim_compiler_execution(self):
        command = [sys.executable, str(MODULE_PATH), "--backend", "java",
                   "--require-compiler-evidence"]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 3)
        self.assertIn("NOT_EXECUTED", result.stderr)

    def test_cli_rejects_tampered_manifest(self):
        mutated = copy.deepcopy(self.original)
        mutated["status"] = "all_backends_green"
        with tempfile.TemporaryDirectory() as tmp:
            filename = Path(tmp) / "manifest.json"
            filename.write_text(json.dumps(mutated), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), "--backend", "llvm", "--manifest", str(filename)],
                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("INVALID", result.stderr)


if __name__ == "__main__":
    unittest.main()
