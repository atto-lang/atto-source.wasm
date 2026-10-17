#!/usr/bin/env python3
"""Adversarial tests for actor-arena lifecycle evidence policy."""
import copy
import unittest
from pathlib import Path
from verify_actor_arena_lifecycle_contract import ContractError, validate, validate_raw

DATA = Path(__file__).resolve().parents[1] / "contracts/v1/actor_arena_lifecycle_v1.json"

class ActorArenaLifecyclePolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = DATA.read_bytes()
        cls.base = validate_raw(cls.raw)

    def reject(self, mutate):
        doc = copy.deepcopy(self.base)
        mutate(doc)
        with self.assertRaises(ContractError):
            validate(doc)

    def test_original(self): validate(self.base)
    def test_duplicate_key(self):
        with self.assertRaises(ContractError):
            validate_raw(b'{"x":1,"x":2}')
    def test_bom(self):
        with self.assertRaises(ContractError):
            validate_raw(b"\xef\xbb\xbf" + self.raw)
    def test_scope_cannot_certify_runtime(self):
        self.reject(lambda d: d.update(scope="five backend runtime parity certified"))
    def test_lifecycle_order_cannot_collapse_done_and_reclaim(self):
        self.reject(lambda d: d["lifecycle_order"].remove("authority-revocation"))
    def test_unknown_backend(self):
        self.reject(lambda d: d["backend_support"].update(other={}))
    def test_missing_backend(self):
        self.reject(lambda d: d["backend_support"].pop("forge"))
    def test_java_physical_reclaim_cannot_be_promoted(self):
        self.reject(lambda d: d["backend_support"]["java"].update(
            physical_reclamation="source-implemented-unverified"))
    def test_wasm_physical_reclaim_cannot_be_promoted(self):
        self.reject(lambda d: d["backend_support"]["wasm"].update(
            physical_reclamation="source-implemented-unverified"))
    def test_llvm_native_evidence_stays_pending(self):
        self.reject(lambda d: d["backend_support"]["llvm"].update(
            exact_head_native_evidence="certified"))
    def test_net_native_evidence_stays_pending(self):
        self.reject(lambda d: d["backend_support"]["net"].update(
            exact_head_native_evidence="certified"))
    def test_forge_native_evidence_stays_pending(self):
        self.reject(lambda d: d["backend_support"]["forge"].update(
            exact_head_native_evidence="certified"))
    def test_java_native_evidence_stays_pending(self):
        self.reject(lambda d: d["backend_support"]["java"].update(
            exact_head_native_evidence="certified"))
    def test_wasm_native_evidence_stays_pending(self):
        self.reject(lambda d: d["backend_support"]["wasm"].update(
            exact_head_native_evidence="certified"))
    def test_guest_lowering_stays_unverified(self):
        self.reject(lambda d: d["backend_support"]["llvm"].update(
            guest_allocation_lowering="source-implemented-unverified"))
    def test_quiescence_stays_unverified(self):
        self.reject(lambda d: d["backend_support"]["forge"].update(
            ffi_borrow_io_quiescence="source-implemented-unverified"))
    def test_scratch_revocation_cannot_be_weakened(self):
        self.reject(lambda d: d["backend_support"]["net"].update(
            scratch_turn_revocation="unverified"))
    def test_incarnation_fencing_cannot_be_weakened(self):
        self.reject(lambda d: d["backend_support"]["wasm"].update(
            incarnation_fencing="unverified"))
    def test_foreign_carrier_denial_cannot_be_weakened(self):
        self.reject(lambda d: d["backend_support"]["java"].update(
            foreign_carrier_denial="unverified"))
    def test_nonrecycling_identity_cannot_be_weakened(self):
        self.reject(lambda d: d["backend_support"]["forge"].update(
            nonrecycling_identity="unverified"))
    def test_drop_case(self):
        self.reject(lambda d: d["cases"].pop())
    def test_duplicate_case(self):
        self.reject(lambda d: d["cases"].append(copy.deepcopy(d["cases"][0])))
    def test_done_is_not_reclaimed_expectation_pinned(self):
        self.reject(lambda d: next(x for x in d["cases"]
                                   if x["id"] == "done-is-not-reclaimed")
                    .update(expect="same-state"))
    def test_native_steps_must_be_nonzero(self):
        self.reject(lambda d: next(x for x in d["cases"]
                                   if x["id"] == "native-job-must-execute-steps")
                    .update(expect="workflow-conclusion-only"))
    def test_receipt_binding_required(self):
        self.reject(lambda d: next(x for x in d["cases"]
                                   if x["id"] == "receipt-must-bind-head-and-tree")
                    .update(expect="optional"))
    def test_nonfinite_token(self):
        with self.assertRaises(ContractError):
            validate_raw(b'{"version":NaN}')
    def test_extreme_depth_fails_closed(self):
        with self.assertRaises(ContractError):
            validate_raw(b"[" * 5000 + b"0" + b"]" * 5000)

if __name__ == "__main__":
    expected = 27
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ActorArenaLifecyclePolicyTest)
    if suite.countTestCases() != expected:
        raise SystemExit(f"FAIL lifecycle gate: expected {expected}, found {suite.countTestCases()}")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if (result.testsRun != expected or not result.wasSuccessful() or result.skipped
            or result.expectedFailures or result.unexpectedSuccesses):
        raise SystemExit("FAIL lifecycle policy tests incomplete or skipped")
