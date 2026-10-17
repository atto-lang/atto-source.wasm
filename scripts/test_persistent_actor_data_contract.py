#!/usr/bin/env python3
"""Negative policy mutations; no claim of guest/runtime execution."""
import copy
import json
import os
import unittest
import tempfile
from unittest.mock import patch
from pathlib import Path
from verify_persistent_actor_data_contract import (ContractError, validate, validate_raw,
                                                    read_bounded_contract)

DATA = Path(__file__).resolve().parents[1] / "contracts/v1/persistent_actor_data_v1.json"


class PersistentActorPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = read_bounded_contract(DATA)

    def reject(self, transform):
        value = copy.deepcopy(self.base)
        transform(value)
        with self.assertRaises(ContractError):
            validate(value)

    def test_original(self):
        validate(self.base)

    def test_duplicate_wire_key(self):
        with self.assertRaises(ContractError):
            validate_raw(b'{"x":1,"x":2}')

    def test_bom(self):
        with self.assertRaises(ContractError):
            validate_raw(b"\xef\xbb\xbf" + DATA.read_bytes())

    def test_unknown_backend(self):
        self.reject(lambda d: d["backend_support"].update({"other": {}}))

    def test_claim_premature_native_hamt(self):
        self.reject(lambda d: d["backend_support"]["llvm"].update({"native_backed_hamt": "implemented"}))

    def test_claim_premature_source_syntax(self):
        self.reject(lambda d: d["backend_support"]["java"].update({"source_language_persistent_map": "implemented"}))

    def test_forge_false_implementation(self):
        self.reject(lambda d: d["backend_support"]["forge"].update({"hamt_runtime": "host-prototype"}))

    def test_collision_cap_expansion(self):
        self.reject(lambda d: d["limits"].update({"collision_bucket_max": 100000}))

    def test_depth_budget_expansion(self):
        self.reject(lambda d: d["limits"].update({"actor_message_graph_depth_max": 999999}))

    def test_graph_budget_expansion(self):
        self.reject(lambda d: d["limits"].update({"actor_message_graph_nodes_max": 999999}))

    def test_drop_fixture(self):
        self.reject(lambda d: d["cases"].pop())

    def test_duplicate_fixture(self):
        self.reject(lambda d: d["cases"].append(d["cases"][0]))

    def test_weaken_quota(self):
        self.reject(lambda d: d["cases"].__setitem__(17, {
            "id": "hamt-duplicate-send-quota", "domain": "actor-quotas", "expect": "unsupported"}))

    def test_weaken_immutability(self):
        self.reject(lambda d: next(c for c in d["cases"] if c["id"] == "hamt-array-input")
                    .update({"expect": "preserve-identity"}))

    def test_allow_new_mutable_type(self):
        self.reject(lambda d: d["value_domain"].append("mutable-buffer"))

    def test_claim_runtime_parity(self):
        self.reject(lambda d: d.update({"scope": "five backend runtime parity verified"}))

    def test_reject_float_collision_limit(self):
        self.reject(lambda d: d["limits"].update({"collision_bucket_max": 64.0}))

    def test_reject_float_graph_budget(self):
        self.reject(lambda d: d["limits"].update({"actor_message_graph_nodes_max": 100000.0}))

    def test_reject_unhashable_domain_without_crash(self):
        self.reject(lambda d: d["cases"][0].update({"domain": ["persistent-map"]}))

    def test_reject_unhashable_outcome_without_crash(self):
        self.reject(lambda d: d["cases"][0].update({"expect": ["old-root-preserved"]}))

    def test_reject_ambiguous_scope_claim(self):
        self.reject(lambda d: d.update({"scope": d["scope"] + "; claimed parity verified"}))

    def test_reject_nonfinite_wire_token(self):
        with self.assertRaises(ContractError):
            validate_raw(b'{"version": NaN}')

    def test_oversized_json_integer_must_fail_closed(self):
        # CPython 3.11+ can raise ValueError before schema validation.
        with self.assertRaises(ContractError):
            validate_raw(b'{"version":' + b'9' * 5000 + b'}')

    def test_extreme_json_depth_must_fail_closed(self):
        nested = b'[' * 5000 + b'0' + b']' * 5000
        with self.assertRaises(ContractError):
            validate_raw(nested)


    def test_pinned_fixture_read_is_supported(self):
        self.assertEqual(read_bounded_contract(DATA)["version"], 1)

    def test_reject_symlinked_contract_fixture(self):
        # No OS-specific symlink creation privileges needed on Windows.
        with patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaisesRegex(ContractError, "regular file"):
                read_bounded_contract(DATA)

    def test_reject_empty_persistent_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            empty = Path(temp) / "empty.json"
            empty.touch()
            with self.assertRaisesRegex(ContractError, "empty"):
                read_bounded_contract(empty)

    def test_reject_hardlinked_persistent_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "original.json"
            path.write_bytes(DATA.read_bytes())
            alias = Path(temp) / "hardlink.json"
            try:
                os.link(path, alias)
            except (OSError, NotImplementedError):
                # Some Windows filesystems disallow creating a hardlink.
                # Other platforms execute both negative assertions.
                self.assertEqual(read_bounded_contract(path)["version"], 1)
                return
            for candidate in (path, alias):
                with self.subTest(path=candidate):
                    with self.assertRaisesRegex(ContractError, "unique regular file"):
                        read_bounded_contract(candidate)

    def test_reject_fifo_persistent_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "fifo.json"
            if not hasattr(os, "mkfifo"):
                # FIFO creation is not available on Windows.
                self.assertTrue(os.name == "nt")
                return
            try:
                os.mkfifo(path)
            except (OSError, NotImplementedError):
                self.assertTrue(os.name == "nt")
                return
            with self.assertRaisesRegex(ContractError, "unique regular file"):
                read_bounded_contract(path)

    def test_reject_path_swapped_after_lstat_before_open(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "original.json"
            path.write_bytes(DATA.read_bytes())
            replacement = Path(temp) / "replacement.json"
            replacement.write_bytes(DATA.read_bytes())
            native_open = os.open
            def raced_open(candidate, flags, *args, **kwargs):
                os.replace(replacement, path)
                return native_open(candidate, flags, *args, **kwargs)
            with patch("verify_persistent_actor_data_contract.os.open",
                       side_effect=raced_open):
                with self.assertRaisesRegex(ContractError, "changed before read"):
                    read_bounded_contract(path)

    def test_reject_path_swapped_after_read_before_final_lstat(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "original.json"
            path.write_bytes(DATA.read_bytes())
            replacement = Path(temp) / "replacement.json"
            replacement.write_bytes(DATA.read_bytes())
            native_fstat = os.fstat
            calls = 0
            def raced_fstat(fd):
                nonlocal calls
                calls += 1
                if calls == 2:
                    os.replace(replacement, path)
                return native_fstat(fd)
            with patch("verify_persistent_actor_data_contract.os.fstat",
                       side_effect=raced_fstat):
                with self.assertRaisesRegex(ContractError, "path changed during read"):
                    read_bounded_contract(path)
            self.assertEqual(calls, 2)

    def test_reject_oversized_contract_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "oversized.json"
            with path.open("wb") as stream:
                stream.truncate(64 * 1024 + 1)
            with self.assertRaisesRegex(ContractError, "oversized"):
                read_bounded_contract(path)


if __name__ == "__main__":
    expected = 32
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PersistentActorPolicyTest)
    if suite.countTestCases() != expected:
        raise SystemExit(f"FAIL persistent-data gate: expected {expected} tests, "
                         f"found {suite.countTestCases()}")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if (result.testsRun != expected or not result.wasSuccessful() or
            result.skipped or result.expectedFailures or result.unexpectedSuccesses):
        raise SystemExit("FAIL persistent-data regressions incomplete or skipped")
