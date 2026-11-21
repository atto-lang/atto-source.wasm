#!/usr/bin/env python3
"""Validate the pinned five-backend serde policy. STATIC contract only.

This is intentionally not a compiler, codec, or runtime conformance test.
A runtime or CI parity claim needs independently executed tests on its exact tree.
"""
import hashlib
import json
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / 'contracts' / 'v1' / 'serde_boundary_v1.json'
EXPECTED_SHA256 = '0057fa040cd23857ee14b232472c5056a74e11c9528b8b06dbe348023d97106d'
MAX_CONTRACT_BYTES = 16_384


class ContractError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise ContractError(reason)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON object key: ' + key)
        result[key] = value
    return result


def unique_set(values, field):
    require(type(values) is list and all(type(v) is str for v in values),
            field + ' must be a list of strings')
    require(len(values) == len(set(values)), field + ' contains duplicates')
    return set(values)


def verify_document(doc):
    require(type(doc) is dict, 'contract must be an object')
    require(doc.get('contract') == 'oreslang.sendable-serializable.v1', 'wrong contract revision')
    require(doc.get('status') == 'normative_security_invariants_not_feature_support',
            'policy is not runtime implementation evidence')
    bounds = doc.get('boundaries')
    require(type(bounds) is dict and set(bounds) ==
            {'actor_data', 'network_data', 'supervisor_control'}, 'boundary domain drift')
    actor, network, control = (bounds[key] for key in
                               ('actor_data', 'network_data', 'supervisor_control'))
    for label, section in [('actor', actor), ('network', network), ('control', control)]:
        require(type(section) is dict, label + ' boundary must be an object')
    require(actor.get('unimplemented_policy') == 'reject_before_enqueue', 'actor fail-open')
    require(network.get('unimplemented_policy') == 'reject_before_io', 'network fail-open')
    require(control.get('unimplemented_policy') == 'reject_without_data_fallback', 'control downgrade')
    require(actor.get('format') == 'messagepack_v2_only_if_implemented', 'unproven actor wire codec')
    require(unique_set(network.get('formats'), 'network formats') ==
            {'json', 'messagepack_v2', 'protobuf'}, 'unexpected network format')
    required = {
        'actor requirements': (actor.get('requirements'), {
            'compiler_sealed_sendable', 'resolved_nominal_type', 'receiver_pinned_codec_if_wire',
            'owned_snapshot_or_exclusive_move', 'quota_before_admission', 'atomic_move_commit'}),
        'actor forbids': (actor.get('forbid'), {
            'borrow', 'raw_pointer', 'mutable_alias', 'actor_ref', 'actor_group_permit',
            'supervisor_control', 'network_codec_object', 'host_handle', 'unproven_option_result'}),
        'network requirements': (network.get('requirements'), {
            'serializable_for_exact_format', 'pinned_schema_and_version',
            'bounded_encode_decode', 'independent_io_permission', 'owned_snapshot'}),
        'control requirements': (control.get('requirements'), {
            'runtime_minted_authority', 'target_and_incarnation_scoped',
            'separate_control_lane', 'revocation_or_replay_check'}),
        'control forbids': (control.get('forbid'), {
            'actor_data_envelope', 'network_data_codec', 'userland_serializable',
            'userland_sendable_authorization'})}
    for field, (values, mandatory) in required.items():
        require(mandatory <= unique_set(values, field), field + ' missing mandatory guarantees')
    invariants = doc.get('invariants')
    require(type(invariants) is dict and invariants, 'missing invariants')
    require(all(value is True for value in invariants.values()), 'invariant disabled')
    for key in ('sendable_is_not_serializable', 'serializable_is_not_sendable',
                'shared_safe_is_not_sendable', 'codec_objects_are_not_data',
                'source_imports_and_generics_are_resolved_before_admission',
                'incoming_bytes_never_select_type_or_codec',
                'schema_hash_is_not_an_authentication_mac',
                'receiver_pins_schema_before_first_send',
                'failed_admission_does_not_consume_sender_ownership',
                'partial_mailbox_admission_is_forbidden',
                'capabilities_cannot_be_nested_in_data', 'unsupported_shapes_fail_closed'):
        require(invariants.get(key) is True, 'missing sealed invariant ' + key)
    wire = doc.get('wire_profile')
    require(type(wire) is dict, 'missing wire profile')
    require(type(wire.get('messagepack_wire_major')) is int and
            wire['messagepack_wire_major'] == 2, 'wrong actor wire major')
    require(wire.get('messagepack_envelope_fields') ==
            ['wire_major', 'schema_id', 'shape_sha256', 'payload'], 'wire framing drift')
    for field, mandatory in {
        'portable_scalar_subset': {'bool', 'signed_i64', 'finite_f64', 'valid_utf8'},
        'typed_collections': {'tuple', 'fixed_array', 'fixed_list', 'array', 'list'},
        'unsupported_without_verified_runtime_codec': {'option', 'result', 'capability'},
        'invalid_bytes_reject': {'invalid_utf8', 'noncanonical_numbers',
                                 'oversized_lengths', 'wrong_shape',
                                 'schema_mismatch', 'wire_downgrade'},
    }.items():
        require(mandatory <= unique_set(wire.get(field), field), field + ' drift')
    verification = doc.get('verification')
    require(type(verification) is dict, 'missing verification policy')
    require(verification.get('requires_executable_code_to_claim_implemented') is True,
            'static policy cannot certify runtimes')
    require(verification.get('unimplemented_feature_must_be_marked_unsupported') is True,
            'unsupported features cannot silently pass')
    require({'positive_scalar', 'nested_capability_reject', 'network_without_permission_reject',
             'control_in_data_reject', 'schema_version_mismatch_reject',
             'sender_snapshot_mutation', 'rejected_send_ownership_rollback',
             'bounded_decode', 'generation_replay_reject', 'cross_backend_golden_bytes'} <=
            unique_set(verification.get('categories'), 'verification categories'),
            'missing runtime conformance category')
    return True


def verify_file(path=CONTRACT):
    path = Path(path)
    require(stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink(),
            'contract must be a regular file, not a symlink')
    # Reject giant inputs before allocating a copy in memory. lstat above also
    # makes a checked-out symlinked contract an explicit error.
    require(path.stat().st_size <= MAX_CONTRACT_BYTES, 'oversized contract')
    raw = path.read_bytes()
    require(len(raw) <= MAX_CONTRACT_BYTES, 'oversized contract')
    digest = hashlib.sha256(raw).hexdigest()
    require(digest == EXPECTED_SHA256, 'contract bytes drift; bump policy version deliberately')
    try:
        doc = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ContractError('invalid JSON / UTF-8') from exc
    verify_document(doc)
    return digest


if __name__ == '__main__':
    try:
        digest = verify_file()
    except (ContractError, OSError) as exc:
        raise SystemExit('FAIL static serde policy: ' + str(exc)) from exc
    print('PASS static serde v1 policy sha256=' + digest +
          ' (NOT compiler/runtime or cross-backend feature parity)')
