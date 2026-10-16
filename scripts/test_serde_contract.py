#!/usr/bin/env python3
"""Negative/mutation tests for the common STATIC serde policy validator."""
import copy
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

    def test_reject_disabled_invariant(self):
        self.mutate(lambda d: d['invariants'].update(capabilities_cannot_be_nested_in_data=False))

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
    expected = 22
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SerdePolicyRegression)
    if suite.countTestCases() != expected:
        raise SystemExit(f'FAIL: expected {expected} serde regressions, '
                         f'found {suite.countTestCases()}')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if (result.testsRun != expected or not result.wasSuccessful() or
            result.skipped or result.expectedFailures or result.unexpectedSuccesses):
        raise SystemExit('FAIL: serde policy regression gate incomplete')
