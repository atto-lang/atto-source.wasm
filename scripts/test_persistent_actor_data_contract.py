#!/usr/bin/env python3
"""Negative policy mutations; no claim of guest/runtime execution."""
import copy
import hashlib
import re
import json
import os
import stat
import unittest
import tempfile
from unittest.mock import patch
from pathlib import Path
import importlib.util

# Resolve the source-pinned neighbor by file path under Python isolated mode.
# Never accept an ambient PYTHONPATH module with the same import name.
_POLICY_PATH = Path(__file__).with_name("verify_persistent_actor_data_contract.py")
_POLICY_SPEC = importlib.util.spec_from_file_location(
    "_oreslang_persistent_actor_data_policy", _POLICY_PATH)
if _POLICY_SPEC is None or _POLICY_SPEC.loader is None:
    raise RuntimeError("cannot load adjacent pinned actor-data policy verifier")
_policy = importlib.util.module_from_spec(_POLICY_SPEC)
_POLICY_SPEC.loader.exec_module(_policy)
ContractError = _policy.ContractError
validate = _policy.validate
validate_raw = _policy.validate_raw
read_bounded_contract = _policy.read_bounded_contract

DATA = Path(__file__).resolve().parents[1] / "contracts/v1/persistent_actor_data_v1.json"



# Integrity pins are executable checks, not evidence of guest/runtime parity.
ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/persistent-actor-data-contract.yml"
PINNED_FILES = (
    "contracts/v1/persistent_actor_data_v1.json",
    "scripts/verify_persistent_actor_data_contract.py",
    "scripts/test_persistent_actor_data_contract.py",
)


def check_workflow_blob_pins(workflow):
    lines = [line.strip() for line in workflow.splitlines()
             if "git hash-object" in line]
    if len(lines) != len(PINNED_FILES):
        raise AssertionError("missing or duplicated workflow integrity pins")
    for path in PINNED_FILES:
        prefix = 'test "$(git hash-object ' + path + ')" = "'
        matching = [line for line in lines if line.startswith(prefix)]
        if len(matching) != 1 or not re.fullmatch(
                re.escape(prefix) + r"[0-9a-f]{40}" + '"', matching[0]):
            raise AssertionError("missing or malformed integrity pin: " + path)
        expected = matching[0][len(prefix):-1]
        raw = (ROOT / path).read_bytes()
        actual = hashlib.sha1(
            b"blob " + str(len(raw)).encode("ascii") + b"\x00" + raw
        ).hexdigest()
        if expected != actual:
            raise AssertionError("stale integrity pin: " + path)
    # These source-only diagnostics must run once per job, after real tests.
    if (workflow.count("- name: Record source-local checkout identity") != 2
            or workflow.count("- name: Upload source-local diagnostic metadata") != 2):
        raise AssertionError("missing or duplicated source-local diagnostics")
    for line in workflow.splitlines():
        if "ctest --test-dir" in line and (
                line.count("'") != 2 or not line.rstrip().endswith("'")):
            raise AssertionError("unterminated native CTest shell command")


class PersistentActorPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = read_bounded_contract(DATA)

    def reject(self, transform):
        value = copy.deepcopy(self.base)
        transform(value)
        with self.assertRaises(ContractError):
            validate(value)

    def test_workflow_blob_pins(self):
        check_workflow_blob_pins(WORKFLOW.read_text(encoding="utf-8"))

    def test_workflow_pin_mutations(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        prefix = 'test "$(git hash-object ' + PINNED_FILES[0] + ')" = "'
        match = next(line.strip() for line in workflow.splitlines()
                     if line.strip().startswith(prefix))
        mutants = (
            workflow.replace(match, "", 1),
            workflow + "\n" + match,
            workflow.replace(match, match[:-41] + "0" * 40 + '"', 1),
        )
        for mutated in mutants:
            with self.subTest(mutated_pin=mutated != workflow):
                with self.assertRaises(AssertionError):
                    check_workflow_blob_pins(mutated)

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


    def test_missing_secure_open_mask_denies_without_open(self):
        for flag in ("O_NOFOLLOW", "O_NONBLOCK"):
            for value in (None, 0):
                with self.subTest(flag=flag, value=value):
                    with patch.object(os, flag, value, create=True):
                        with patch.object(os, "open", side_effect=AssertionError("unsafe open")) as opened:
                            with self.assertRaisesRegex(ContractError, "safe independent"):
                                read_bounded_contract(DATA)
                            opened.assert_not_called()

    def test_malformed_secure_open_mask_denies_without_open(self):
        for flag in ("O_NOFOLLOW", "O_NONBLOCK"):
            for value in (True, False, -1, "not-an-int", 1.5):
                with self.subTest(flag=flag, value=value):
                    with patch.object(os, flag, value, create=True):
                        with patch.object(os, "open", side_effect=AssertionError("unsafe open")) as opened:
                            with self.assertRaisesRegex(ContractError, "safe independent"):
                                read_bounded_contract(DATA)
                            opened.assert_not_called()

    def test_aliased_secure_open_mask_denies_without_open(self):
        candidates = (("O_NOFOLLOW", os.O_NONBLOCK),
                      ("O_NONBLOCK", os.O_NOFOLLOW | os.O_NONBLOCK),
                      ("O_BINARY", os.O_NONBLOCK))
        for flag, value in candidates:
            with self.subTest(flag=flag, value=value):
                with patch.object(os, flag, value, create=True):
                    with patch.object(os, "open", side_effect=AssertionError("unsafe open")) as opened:
                        with self.assertRaisesRegex(ContractError, "safe independent"):
                            read_bounded_contract(DATA)
                        opened.assert_not_called()

    def test_pinned_fixture_read_is_supported(self):
        self.assertEqual(read_bounded_contract(DATA)["version"], 1)

    def test_reject_symlinked_contract_fixture(self):
        # Exercise the descriptor-based lstat admission instead of the old
        # Path.is_symlink() preflight (which the hardened reader no longer uses).
        original = DATA.lstat()
        fake = os.stat_result((stat.S_IFLNK | 0o777,) + tuple(original)[1:])
        with patch.object(Path, "lstat", return_value=fake):
            with self.assertRaisesRegex(ContractError, "regular file"):
                read_bounded_contract(DATA)

    def test_reject_exponent_overflow_before_schema_interpretation(self):
        with self.assertRaisesRegex(ContractError, "non-finite"):
            validate_raw(b'{"version": 1e999}')

    def test_reject_directory_as_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ContractError, "unique regular file"):
                read_bounded_contract(Path(temp))

    def test_reject_hardlinked_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp) / "valid.json"
            data.write_bytes(DATA.read_bytes())
            alias = Path(temp) / "hardlink.json"
            try:
                os.link(data, alias)
            except (OSError, NotImplementedError):
                # Some Windows runner volumes do not permit hardlinks;
                # the cross-platform OS-independent directory case still runs.
                return
            with self.assertRaisesRegex(ContractError, "unique regular file"):
                read_bounded_contract(alias)

    def test_reject_oversized_contract_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "oversized.json"
            with path.open("wb") as stream:
                stream.truncate(64 * 1024 + 1)
            with self.assertRaisesRegex(ContractError, "oversized"):
                read_bounded_contract(path)


    def test_reject_changed_open_descriptor_during_read(self):
        # Simulate a file changing after the initial descriptor identity
        # check. A normal start-of-read lstat alone must never certify it.
        original = os.fstat
        reads = [0]
        def mutated(fd):
            before = original(fd)
            reads[0] += 1
            if reads[0] == 2:
                fields = list(before)
                fields[1] += 1  # st_ino differs after payload read
                return os.stat_result(fields)
            return before
        with patch.object(os, "fstat", side_effect=mutated):
            with self.assertRaisesRegex(ContractError, "changed during read"):
                read_bounded_contract(DATA)
        self.assertEqual(reads[0], 2)

    def test_reject_replaced_contract_path_after_read(self):
        # Simulate a rename/swap after data was read successfully. The
        # final name must still refer to the exact opened descriptor.
        original = Path.lstat
        reads = [0]
        def mutated(path):
            before = original(path)
            reads[0] += 1
            if reads[0] == 2:
                fields = list(before)
                fields[1] += 1  # same pathname, different inode
                return os.stat_result(fields)
            return before
        with patch.object(Path, "lstat", mutated):
            with self.assertRaisesRegex(ContractError, "path changed during read"):
                read_bounded_contract(DATA)
        self.assertEqual(reads[0], 2)


if __name__ == "__main__":
    expected = 37
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PersistentActorPolicyTest)
    if suite.countTestCases() != expected:
        raise SystemExit(f"FAIL persistent-data gate: expected {expected} tests, "
                         f"found {suite.countTestCases()}")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if (result.testsRun != expected or not result.wasSuccessful() or
            result.skipped or result.expectedFailures or result.unexpectedSuccesses):
        raise SystemExit("FAIL persistent-data regressions incomplete or skipped")
