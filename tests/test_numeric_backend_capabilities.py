"""Fail-closed manifest integrity checks for all five Oreslang numeric backends.

Passing these tests verifies *reference data and honest capability reporting*.
It is NOT compiled guest execution or evidence that any backend has parity.
"""
import hashlib
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "contracts/v1/numeric-parity/backend.json"
GOLDEN = ROOT / "contracts/v1/numeric-precision/cases.json"
SHA = "cb28b5678d380f02c5e4e43bd763da04bdb996fe"
FEATURES = frozenset((
    "source_i64", "checked_i64_overflow", "binary64_ordering",
    "binary32_arithmetic", "bigint_exact", "decimal_exact",
    "complex_binary64", "decimal_matrix", "source_division_to_float"))
STATUSES = frozenset((
    "unsupported_explicit", "delegated_unverified",
    "implemented_unverified", "reference_only", "blocked_unsound",
    "needs_audit", "verified_compiled"))
BACKENDS = frozenset(("java", "llvm", "net", "wasm", "forge"))
SHA40 = re.compile(r"[0-9a-f]{40}")


class NumericParityAdmissionTest(unittest.TestCase):
    def test_reference_fixture_is_byte_identical_across_backends(self):
        raw = GOLDEN.read_bytes()
        actual = hashlib.sha1(
            b"blob " + str(len(raw)).encode("ascii") + bytes((0,)) + raw).hexdigest()
        self.assertEqual(actual, SHA, "reference vectors changed without cross-backend review")
        data = json.loads(raw)
        self.assertEqual(data["schema_version"], "1.0.0")
        self.assertEqual(data["status"], "reference-only-not-guest-execution")

    def test_manifest_does_not_claim_unexecuted_guest_parity(self):
        d = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(d["schema_version"], "1.0.0")
        self.assertIn(d["backend"], BACKENDS)
        self.assertEqual(d["reference_fixture_git_blob_sha"], SHA)
        self.assertEqual(set(d["capabilities"]), FEATURES)
        self.assertEqual(set(d["evidence"]), FEATURES)
        for name, status in d["capabilities"].items():
            with self.subTest(feature=name):
                self.assertIn(status, STATUSES)
                proof = d["evidence"][name]
                self.assertIsInstance(proof, dict)
                if status != "verified_compiled":
                    # No source-execution proof is allowed for unverified claims.
                    self.assertEqual(proof, {}, "unverified feature must not attach a forged pass")
                else:
                    self.assertTrue(SHA40.fullmatch(proof["exact_source_commit_sha"]))
                    self.assertRegex(proof["workflow_run_url"],
                                     r"^https://github[.]com/[^/]+/[^/]+/actions/runs/[0-9]+$")
                    self.assertIs(type(proof["executed_positive_cases"]), int)
                    self.assertGreater(proof["executed_positive_cases"], 0)
                    self.assertIs(type(proof["executed_negative_cases"]), int)
                    self.assertGreater(proof["executed_negative_cases"], 0)
                    self.assertTrue(proof["actual_compiler_guest_execution"] is True)
                    self.assertEqual(proof["reviewed_reference_git_blob_sha"], SHA)

    def test_manifest_states_are_conservatively_scoped(self):
        d = json.loads(MANIFEST.read_text(encoding="utf-8"))
        b, c = d["backend"], d["capabilities"]
        if b == "wasm":
            self.assertEqual(c["source_i64"], "delegated_unverified")
            self.assertNotIn("verified_compiled", c.values())
        elif b in ("net", "forge"):
            for name in ("binary64_ordering", "binary32_arithmetic",
                         "bigint_exact", "decimal_exact", "decimal_matrix"):
                self.assertEqual(c[name], "unsupported_explicit")
        elif b == "llvm":
            self.assertNotEqual(c["bigint_exact"], "verified_compiled")
        elif b == "java":
            self.assertNotEqual(c["binary32_arithmetic"], "verified_compiled")


if __name__ == "__main__":
    unittest.main()
