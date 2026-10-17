#!/usr/bin/env python3
"""Validate the normative actor hook corpus; NEVER impersonate compiler execution."""
import argparse
import json
from pathlib import Path

EXPECTED_BACKENDS = ("java", "llvm", "net", "wasm", "forge")
EXPECTED_STATUS = {
    "java": "candidate_unverified",
    "llvm": "partial_candidate_unverified",
    "net": "fail_closed_until_compiler_support",
    "wasm": "fail_closed_until_compiler_support",
    "forge": "fail_closed_until_compiler_support",
}
EXPECTED_VECTORS = (
    "class_dispatch",
    "class_derived_call",
    "class_public_widening",
    "class_argument_mismatch",
    "class_return_mismatch",
    "class_missing_implementation",
    "actor_receive_self",
    "actor_receive_implicit",
    "actor_receive_duplicate",
    "actor_receive_direct",
    "actor_receive_reference",
    "actor_on_start_direct",
)
EXPECTED_ACCEPT = {"class_dispatch", "actor_receive_self", "actor_receive_implicit"}
REQUIRED_RULES = {
    "origin_class_only_invocation",
    "must_implement_concrete",
    "same_slot_inline_self",
    "deny_method_capture",
    "deny_direct_receive",
    "deny_direct_on_start",
    "deny_visibility_widening",
    "deny_signature_drift",
    "deny_ambiguous_origin",
    "fail_closed_unsupported",
    "compiler_evidence_required",
    "protected_approval_before_private_mirror",
}

class ContractError(ValueError):
    pass

def validate(document):
    if not isinstance(document, dict):
        raise ContractError("document must be object")
    if document.get("contract") != "oreslang.private-abstract-actor-hook.v1":
        raise ContractError("wrong contract identifier")
    if document.get("status") != "normative_expected_not_compiler_evidence":
        raise ContractError("manifest cannot claim compiled evidence")
    if tuple(document.get("backend_order", [])) != EXPECTED_BACKENDS:
        raise ContractError("missing, reordered or duplicate backend")
    matrix = document.get("backend_capabilities")
    if not isinstance(matrix, dict) or set(matrix) != set(EXPECTED_BACKENDS):
        raise ContractError("backend capability matrix incomplete")
    for backend, expected_status in EXPECTED_STATUS.items():
        entry = matrix[backend]
        if not isinstance(entry, dict) or entry.get("status") != expected_status:
            raise ContractError("unverified backend cannot be promoted: " + backend)
        if not all(isinstance(entry.get(k), str) and entry[k].strip()
                   for k in ("candidate", "requires")):
            raise ContractError("missing compiler evidence contract: " + backend)
    rules = document.get("rules")
    if not isinstance(rules, list) or len(rules) != len(set(rules)) or set(rules) != REQUIRED_RULES:
        raise ContractError("required authority/evidence rules are missing or duplicated")
    vectors = document.get("vectors")
    if not isinstance(vectors, list) or len(vectors) != len(EXPECTED_VECTORS):
        raise ContractError("source vector count changed")
    seen = set()
    for item in vectors:
        if not isinstance(item, dict):
            raise ContractError("invalid source vector")
        identifier = item.get("id")
        if identifier not in EXPECTED_VECTORS or identifier in seen:
            raise ContractError("unknown or duplicate source vector: " + str(identifier))
        seen.add(identifier)
        expected = "accept" if identifier in EXPECTED_ACCEPT else "reject"
        if item.get("expected") != expected:
            raise ContractError("expected acceptance was changed: " + identifier)
        scope = "actor" if identifier.startswith("actor_") else "class"
        if item.get("scope") != scope:
            raise ContractError("source scope changed: " + identifier)
        source = item.get("source")
        if not isinstance(source, str) or not source.strip() or "define " not in source:
            raise ContractError("missing executable source fixture: " + identifier)
        diagnostic = item.get("diagnostic")
        if not isinstance(diagnostic, str) or not diagnostic.strip():
            raise ContractError("missing diagnostic classification: " + identifier)
        if identifier == "actor_receive_self" and "receive(self, ActorMail<String> mail)" not in source:
            raise ContractError("explicit Self ABI fixture has drifted")
        if identifier == "actor_receive_implicit" and "receive(ActorMail<String> mail)" not in source:
            raise ContractError("implicit Self ABI fixture has drifted")
    if seen != set(EXPECTED_VECTORS):
        raise ContractError("missing required source vector")
    return {"contract_valid": True, "vectors": len(vectors), "backend_count": len(matrix),
            "compiler_executed": False, "parity_proven": False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, choices=EXPECTED_BACKENDS)
    parser.add_argument("--manifest", type=Path,
                        default=Path(__file__).with_name("private-abstract-actor-hook-v1.json"))
    parser.add_argument("--require-compiler-evidence", action="store_true",
                        help="Fail closed: offline manifest validation is never compiler evidence")
    args = parser.parse_args()
    try:
        result = validate(json.loads(args.manifest.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError) as exc:
        parser.exit(2, "PRIVATE_ABSTRACT_ACTOR_HOOK_INVALID: " + str(exc) + "\n")
    if args.require_compiler_evidence:
        parser.exit(3, "PRIVATE_ABSTRACT_ACTOR_HOOK_NOT_EXECUTED: run exact-tree real compiler tests\n")
    print(json.dumps({"backend": args.backend, **result}, sort_keys=True))

if __name__ == "__main__":
    main()
