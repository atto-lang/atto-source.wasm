#!/usr/bin/env python3
"""Adversarial source-free tests for actor arena lifecycle v1."""
import copy
from pathlib import Path
import unittest
from verify_actor_arena_lifecycle_v1 import ContractError, validate, validate_raw

DATA = Path(__file__).resolve().parents[1] / "contracts/v1/actor_arena_lifecycle_v1.json"

class ActorArenaLifecycleV1Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = validate_raw(DATA.read_bytes())

    def reject(self, mutate):
        doc = copy.deepcopy(self.base)
        mutate(doc)
        with self.assertRaises(ContractError):
            validate(doc)

    def test_original(self):
        validate(self.base)

    def test_duplicate_wire_key(self):
        with self.assertRaises(ContractError):
            validate_raw(b'{"contract":"x","contract":"y"}')

    def test_bom(self):
        with self.assertRaises(ContractError):
            validate_raw(b"\xef\xbb\xbf" + DATA.read_bytes())

    def test_missing_backend(self):
        self.reject(lambda d: d["backend_support"].pop("forge"))

    def test_unknown_backend(self):
        self.reject(lambda d: d["backend_support"].update({"other": {}}))

    def test_invariant_drop(self):
        self.reject(lambda d: d["required_invariants"].pop())

    def test_invariant_reorder(self):
        self.reject(lambda d: d["required_invariants"].reverse())

    def test_actorref_arena_access_must_not_be_removed(self):
        self.reject(lambda d: d["required_invariants"].remove("actorref-never-grants-arena-access"))

    def test_scratch_turn_exit_must_not_be_removed(self):
        self.reject(lambda d: d["required_invariants"].remove("scratch-invalid-after-every-turn-exit"))

    def test_reclamation_quiescence_must_not_be_removed(self):
        self.reject(lambda d: d["required_invariants"].remove("physical-reclaim-waits-for-live-borrows-and-turns"))

    def test_java_general_lowering_cannot_be_promoted(self):
        self.reject(lambda d: d["backend_support"]["java"].update({"general_guest_value_lowering":"implemented"}))

    def test_llvm_general_lowering_cannot_be_promoted(self):
        self.reject(lambda d: d["backend_support"]["llvm"].update({"general_guest_value_lowering":"implemented"}))

    def test_net_shared_domain_cannot_be_promoted(self):
        self.reject(lambda d: d["backend_support"]["net"].update({"shared_domain_arena":"implemented"}))

    def test_wasm_shared_domain_cannot_be_promoted(self):
        self.reject(lambda d: d["backend_support"]["wasm"].update({"shared_domain_arena":"implemented"}))

    def test_forge_shared_domain_cannot_be_promoted(self):
        self.reject(lambda d: d["backend_support"]["forge"].update({"shared_domain_arena":"implemented"}))

    def test_zero_host_gc_not_certified(self):
        for backend in self.base["backend_support"]:
            with self.subTest(backend=backend):
                self.reject(lambda d, b=backend: d["backend_support"][b].update({"zero_host_gc_certified": True}))

    def test_native_aot_not_certified(self):
        for backend in self.base["backend_support"]:
            with self.subTest(backend=backend):
                self.reject(lambda d, b=backend: d["backend_support"][b].update({"native_aot_certified": True}))

    def test_exact_head_ci_not_certified(self):
        for backend in self.base["backend_support"]:
            with self.subTest(backend=backend):
                self.reject(lambda d, b=backend: d["backend_support"][b].update({"exact_head_ci_certified": True}))

    def test_candidate_stage_must_match_backend(self):
        self.reject(lambda d: d["backend_support"]["llvm"].update({"candidate_stage":"candidate-host-only-native-arena"}))

if __name__ == "__main__":
    unittest.main()
