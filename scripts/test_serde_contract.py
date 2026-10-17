#!/usr/bin/env python3
"""Negative/mutation tests for the common STATIC serde policy validator."""
import copy
import os
from unittest import mock
import json
import tempfile
import unittest
from pathlib import Path

import verify_serde_contract as policy


class SerdePolicyRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = json.loads(policy.CONTRACT.read_text(encoding='utf-8'))

    def mutate(self, edit):
        modified = copy.deepcopy(self.original)
        edit(modified)
        with self.assertRaises(policy.ContractError):
            policy.verify_document(modified)

    def test_pinned_checked_contract(self):
        self.assertEqual(policy.verify_file(), policy.EXPECTED_SHA256)


    def test_reject_unknown_top_level_policy(self):
        self.mutate(lambda d: d.update(unsafe_compatibility_fallback=True))

    def test_reject_unknown_actor_policy_override(self):
        self.mutate(lambda d: d['boundaries']['actor_data'].update(
            permit_user_codec=True))

    def test_reject_unknown_network_policy_override(self):
        self.mutate(lambda d: d['boundaries']['network_data'].update(
            bypass_permission=True))

    def test_reject_unknown_true_invariant(self):
        self.mutate(lambda d: d['invariants'].update(
            allow_control_as_data=True))

    def test_reject_unknown_wire_profile(self):
        self.mutate(lambda d: d['wire_profile'].update(
            accept_wire_downgrade=True))

    def test_reject_unknown_verification_claim(self):
        self.mutate(lambda d: d['verification'].update(
            claim_runtime_equivalence_without_execution=True))

    def test_reject_nonfinite_json_tokens(self):
        for token in ('NaN', 'Infinity', '-Infinity', '1e999', '-1e999'):
            with self.subTest(token=token), self.assertRaises(policy.ContractError):
                policy.decode_document(('{"number":' + token + '}').encode('utf-8'))


    def test_reject_unlisted_actor_requirement(self):
        self.mutate(lambda d: d['boundaries']['actor_data']['requirements'].append(
            'userland_codec_can_mint_control'))

    def test_reject_unlisted_network_requirement(self):
        self.mutate(lambda d: d['boundaries']['network_data']['requirements'].append(
            'skip_permission_checks'))

    def test_reject_unlisted_wire_scalar(self):
        self.mutate(lambda d: d['wire_profile']['portable_scalar_subset'].append(
            'unchecked_pointer'))

    def test_reject_unsupported_record_codec_promoted(self):
        self.mutate(lambda d: d['wire_profile']['unsupported_without_verified_runtime_codec'].remove(
            'record'))

    def test_reject_unlisted_runtime_conformance_category(self):
        self.mutate(lambda d: d['verification']['categories'].append(
            'static_policy_proves_native_guest_runtime'))

    def test_reject_unbounded_direct_json_decode(self):
        with self.assertRaisesRegex(policy.ContractError, 'oversized'):
            policy.decode_document(b' ' * (policy.MAX_CONTRACT_BYTES + 1))

    def test_reject_disabled_invariant(self):
        self.mutate(lambda d: d['invariants'].update(capabilities_cannot_be_nested_in_data=False))

    def test_reject_missing_shared_safety_distinction(self):
        self.mutate(lambda d: d['invariants'].pop('shared_safe_is_not_sendable'))

    def test_reject_missing_import_generic_resolution(self):
        self.mutate(lambda d: d['invariants'].pop(
            'source_imports_and_generics_are_resolved_before_admission'))

    def test_reject_missing_receiver_schema_pin(self):
        self.mutate(lambda d: d['invariants'].pop('receiver_pins_schema_before_first_send'))

    def test_reject_missing_invariant(self):
        self.mutate(lambda d: d['invariants'].pop('unsupported_shapes_fail_closed'))

    def test_reject_serialization_as_actor_authority(self):
        self.mutate(lambda d: d['boundaries']['actor_data']['forbid'].remove('network_codec_object'))

    def test_reject_unproven_sum_codec(self):
        self.mutate(lambda d: d['boundaries']['actor_data']['forbid'].remove('unproven_option_result'))

    def test_reject_supervisor_control_downgrade(self):
        self.mutate(lambda d: d['boundaries']['supervisor_control'].update(
            unimplemented_policy='serialize_as_data'))

    def test_reject_control_lane_loss(self):
        self.mutate(lambda d: d['boundaries']['supervisor_control']['requirements'].remove(
            'separate_control_lane'))

    def test_reject_missing_io_permission(self):
        self.mutate(lambda d: d['boundaries']['network_data']['requirements'].remove(
            'independent_io_permission'))

    def test_reject_protocol_downgrade(self):
        self.mutate(lambda d: d['wire_profile'].update(messagepack_wire_major=1))

    def test_reject_wire_schema_selector(self):
        self.mutate(lambda d: d['wire_profile']['messagepack_envelope_fields'].append('codec_class'))

    def test_reject_duplicate_policy_entries(self):
        self.mutate(lambda d: d['boundaries']['actor_data']['forbid'].append('borrow'))

    def test_reject_fake_runtime_evidence(self):
        self.mutate(lambda d: d['verification'].update(requires_executable_code_to_claim_implemented=False))

    def test_reject_missing_ownership_rollback(self):
        self.mutate(lambda d: d['invariants'].pop('failed_admission_does_not_consume_sender_ownership'))

    def test_reject_bytes_not_matching_pinned_sha(self):
        with tempfile.TemporaryDirectory() as root:
            bad = Path(root) / 'policy.json'
            bad.write_bytes(policy.CONTRACT.read_bytes() + b'\n')
            with self.assertRaises(policy.ContractError):
                policy.verify_file(bad)


    def test_contract_read_uses_single_nofollow_nonblocking_fd(self):
        actual_open = os.open
        with mock.patch.object(policy.os, 'open', wraps=actual_open) as observed:
            self.assertEqual(policy.verify_file(), policy.EXPECTED_SHA256)
        self.assertEqual(observed.call_count, 1)
        flags = observed.call_args.args[1]
        self.assertTrue(flags & os.O_NOFOLLOW)
        self.assertTrue(flags & os.O_NONBLOCK)
        # A present but unusable zero-valued flag must fail closed.
        with mock.patch.object(policy.os, 'O_NOFOLLOW', 0, create=True):
            with self.assertRaisesRegex(policy.ContractError, 'no safe'):
                policy.verify_file()

    def test_reject_path_swapped_to_symlink_at_open(self):
        with tempfile.TemporaryDirectory() as root:
            location = Path(root) / 'contract.json'
            actual = Path(root) / 'replacement.json'
            content = policy.CONTRACT.read_bytes()
            location.write_bytes(content)
            actual.write_bytes(content)
            true_open = os.open

            def swap_then_open(path, flags, *args, **kwargs):
                location.unlink()
                location.symlink_to(actual)
                return true_open(path, flags, *args, **kwargs)

            with mock.patch.object(policy.os, 'open', side_effect=swap_then_open):
                with self.assertRaises(policy.ContractError):
                    policy.verify_file(location)


    def test_reject_directory_and_release_open_descriptor(self):
        with tempfile.TemporaryDirectory() as root:
            real_open = os.open
            opened = []

            def track_open(path, flags, *args, **kwargs):
                descriptor = real_open(path, flags, *args, **kwargs)
                opened.append(descriptor)
                return descriptor

            with mock.patch.object(policy.os, 'open', side_effect=track_open):
                with self.assertRaisesRegex(policy.ContractError, 'regular file'):
                    policy.verify_file(Path(root))
            self.assertEqual(len(opened), 1)
            with self.assertRaises(OSError):
                os.fstat(opened[0])

    def test_reject_fifo_without_blocking_on_open(self):
        if not hasattr(os, 'mkfifo'):
            with self.assertRaises(policy.ContractError):
                with mock.patch.object(policy.os, 'O_NOFOLLOW', 0):
                    policy.verify_file()
            return
        with tempfile.TemporaryDirectory() as root:
            fifo = Path(root) / 'policy.pipe'
            os.mkfifo(fifo)
            with self.assertRaisesRegex(policy.ContractError, 'regular file'):
                policy.verify_file(fifo)

    def test_reject_symlinked_policy(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'actual.json'
            target.write_bytes(policy.CONTRACT.read_bytes())
            link = Path(root) / 'policy.json'
            link.symlink_to(target)
            with self.assertRaises(policy.ContractError):
                policy.verify_file(link)

    def test_reject_duplicate_json_object_keys(self):
        with self.assertRaises(policy.ContractError):
            json.loads('{"contract":"ok","contract":"override"}',
                       object_pairs_hook=policy.unique_object)

    def test_reject_empty_verification(self):
        self.mutate(lambda d: d['verification'].update(categories=[]))

    def test_reject_array_reorder(self):
        self.mutate(lambda d: d['wire_profile']['messagepack_envelope_fields'].reverse())

    def test_reject_missing_permission_conformance(self):
        self.mutate(lambda d: d['verification']['categories'].remove(
            'network_without_permission_reject'))

    def test_reject_missing_sender_mutation_conformance(self):
        self.mutate(lambda d: d['verification']['categories'].remove(
            'sender_snapshot_mutation'))

    def test_reject_missing_schema_version_conformance(self):
        self.mutate(lambda d: d['verification']['categories'].remove(
            'schema_version_mismatch_reject'))

    def test_reject_huge_contract_before_full_read(self):
        with tempfile.TemporaryDirectory() as root:
            oversized = Path(root) / 'oversized.json'
            with oversized.open('wb') as stream:
                stream.truncate(policy.MAX_CONTRACT_BYTES + 1)
            with self.assertRaisesRegex(policy.ContractError, 'oversized'):
                policy.verify_file(oversized)


if __name__ == '__main__':
    # unittest discover exits 0 even if no tests are discovered. A security
    # gate cannot treat a renamed/deleted suite or skipped test as green.
    expected = 42
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SerdePolicyRegression)
    if suite.countTestCases() != expected:
        raise SystemExit(f'FAIL: expected {expected} serde regressions, '
                         f'found {suite.countTestCases()}')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if (result.testsRun != expected or not result.wasSuccessful() or
            result.skipped or result.expectedFailures or result.unexpectedSuccesses):
        raise SystemExit('FAIL: serde policy regression gate incomplete')
