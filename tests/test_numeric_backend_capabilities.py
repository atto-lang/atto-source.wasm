"""Fail-closed manifest integrity checks for all five Oreslang numeric backends.

Passing these tests verifies *reference data and honest capability reporting*.
It is NOT compiled guest execution or evidence that any backend has parity.
"""
import hashlib
import json
from pathlib import Path
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
EXPECTED_BACKEND = "wasm"  # fixed by repository identity, not user-editable manifest


def check_claim_is_not_self_attested(status, proof):
    if status == "verified_compiled":
        raise ValueError(
            "compiled parity requires independently verified protected CI evidence")
    if proof != {}:
        raise ValueError("unverified feature cannot attach self-reported test evidence")


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
        self.assertEqual(d["backend"], EXPECTED_BACKEND)
        self.assertEqual(d["reference_fixture_git_blob_sha"], SHA)
        self.assertEqual(d["source_i64_fixture_git_blob_sha"],
                         "bbc319c19ecd007109d33592e210091eb267e5a2")
        self.assertEqual(d["source_i64_overflow_fixture_git_blob_sha"],
                         "2ce0b0ff5c52e54a788280fd64d67fa8dc32614a")
        self.assertEqual(set(d["capabilities"]), FEATURES)
        self.assertEqual(set(d["evidence"]), FEATURES)
        for name, status in d["capabilities"].items():
            with self.subTest(feature=name):
                self.assertIn(status, STATUSES)
                proof = d["evidence"][name]
                self.assertIsInstance(proof, dict)
                # A manifest, URL and case counts from this same PR cannot
                # attest to their own compiler execution.
                check_claim_is_not_self_attested(status, proof)

    def test_forged_compiled_status_and_proofs_are_refused(self):
        # Synthetic malicious/self-reported metadata must never promote a
        # capability even when its URL and SHA appear well-formed.
        fabricated = {
            "exact_source_commit_sha": "f" * 40,
            "workflow_run_url": "https://github.com/example/verify/actions/runs/123",
            "executed_positive_cases": 1000,
            "executed_negative_cases": 1000,
            "actual_compiler_guest_execution": True
        }
        with self.assertRaisesRegex(ValueError, "independently verified"):
            check_claim_is_not_self_attested("verified_compiled", fabricated)
        with self.assertRaisesRegex(ValueError, "self-reported"):
            check_claim_is_not_self_attested("implemented_unverified", fabricated)
        check_claim_is_not_self_attested("implemented_unverified", {})

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
