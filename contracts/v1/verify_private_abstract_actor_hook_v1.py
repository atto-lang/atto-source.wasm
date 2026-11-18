#!/usr/bin/env python3
"""Validate the normative actor hook corpus; NEVER impersonate compiler execution."""
import argparse
import json
import os
import stat
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

# Canonical review-pinned fixtures and capability declarations; NOT compiler evidence.
# Any normative change must explicitly update this independent baseline.
EXPECTED_FIXTURES = {
  "class_dispatch": {
    "source": "define abstract class Framework as\n  private abstract receive(int value): int;\n  pub deliver(int value): int { return self.receive(value); }\nend\ndefine class Worker extends Framework as\n  private receive(int value): int { return value + 1; }\nend",
    "diagnostic": "superclass virtual dispatch only"
  },
  "class_derived_call": {
    "source": "define abstract class Framework as\n  private abstract receive(int value): int;\nend\ndefine class Worker extends Framework as\n  private receive(int value): int { return value; }\n  pub bypass(): int { return self.receive(2); }\nend",
    "diagnostic": "private abstract origin authority"
  },
  "class_public_widening": {
    "source": "define abstract class Framework as\n  private abstract receive(int value): int;\nend\ndefine class Worker extends Framework as\n  pub receive(int value): int { return value; }\nend",
    "diagnostic": "private abstract visibility escalation"
  },
  "class_argument_mismatch": {
    "source": "define abstract class Framework as\n  private abstract receive(int value): int;\nend\ndefine class Worker extends Framework as\n  private receive(bool value): int { return 1; }\nend",
    "diagnostic": "private abstract parameter type mismatch"
  },
  "class_return_mismatch": {
    "source": "define abstract class Framework as\n  private abstract receive(int value): int;\nend\ndefine class Worker extends Framework as\n  private receive(int value): bool { return true; }\nend",
    "diagnostic": "private abstract return type mismatch"
  },
  "class_missing_implementation": {
    "source": "define abstract class Framework as\n  private abstract receive(int value): int;\nend\ndefine class Worker extends Framework as\nend",
    "diagnostic": "unresolved abstract slot"
  },
  "actor_receive_self": {
    "source": "define actor Worker as\n  receive(self, ActorMail<String> mail): void {\n    self.end();\n    return;\n  }\nend",
    "diagnostic": "explicit Self receiver normalized to receive/1"
  },
  "actor_receive_implicit": {
    "source": "define actor Worker as\n  receive(ActorMail<String> mail): void {\n    self.end();\n    return;\n  }\nend",
    "diagnostic": "implicit Self receiver normalized to receive/1"
  },
  "actor_receive_duplicate": {
    "source": "define actor Worker as\n  receive(self, ActorMail<String> mail): void { return; }\n  receive(ActorMail<String> mail): void { return; }\nend",
    "diagnostic": "duplicate name and value arity"
  },
  "actor_receive_direct": {
    "source": "define actor Worker as\n  receive(ActorMail<String> mail): void {\n    self.receive(mail);\n    return;\n  }\nend",
    "diagnostic": "runtime-only mailbox ingress"
  },
  "actor_receive_reference": {
    "source": "define actor Worker as\n  receive(ActorMail<String> mail): void {\n    val callback = self.receive;\n    return;\n  }\nend",
    "diagnostic": "runtime-only hook method value capture"
  },
  "actor_on_start_direct": {
    "source": "define actor Worker as\n  on_start(): void { return; }\n  receive(ActorMail<String> mail): void {\n    self.on_start();\n    return;\n  }\nend",
    "diagnostic": "runtime-only startup ingress"
  }
}
EXPECTED_CAPABILITIES = {
  "java": {
    "candidate": "oreslang-source.java#1090",
    "status": "candidate_unverified",
    "requires": "JDK25 Maven + JVM actor guest + Graal Native Image"
  },
  "llvm": {
    "candidate": "oreslang-source.llvm#479",
    "status": "partial_candidate_unverified",
    "requires": "native parser + CTest + compiler-produced guest; canonical receive mapping"
  },
  "net": {
    "candidate": "oreslang-source.net#40",
    "status": "fail_closed_until_compiler_support",
    "requires": "C# source compiler + Native AOT source guest"
  },
  "wasm": {
    "candidate": "oreslang-source.wasm#38",
    "status": "fail_closed_until_compiler_support",
    "requires": "pinned real LLVM compiler + Wasm guest"
  },
  "forge": {
    "candidate": "oreslang-source.forge#36",
    "status": "fail_closed_until_compiler_support",
    "requires": "native Forge compiler + CTest source guest"
  }
}

class ContractError(ValueError):
    pass

MAX_MANIFEST_BYTES = 128 * 1024

def read_manifest_bounded(path):
    """Read a regular manifest via a bounded descriptor; never block on a FIFO."""
    flags = os.O_RDONLY
    for name in ("O_NONBLOCK", "O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        flags |= getattr(os, name, 0)
    # Windows lacks O_NOFOLLOW. Reject obvious links there too, but do not
    # claim race-free symlink rejection without an OS-level no-follow flag.
    if not hasattr(os, "O_NOFOLLOW") and path.is_symlink():
        raise ContractError("manifest symlinks are forbidden")
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ContractError("manifest must be a regular file")
        if before.st_size > MAX_MANIFEST_BYTES:
            raise ContractError("manifest exceeds byte limit")
        remaining = MAX_MANIFEST_BYTES + 1
        parts = []
        while remaining:
            piece = os.read(fd, min(8192, remaining))
            if not piece:
                break
            parts.append(piece)
            remaining -= len(piece)
        data = b"".join(parts)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
        if identity(before) != identity(after) or len(data) != before.st_size:
            raise ContractError("manifest changed while being read")
        if len(data) > MAX_MANIFEST_BYTES:
            raise ContractError("manifest exceeds byte limit")
        return data
    finally:
        os.close(fd)

def _unique_json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("duplicate JSON member: " + key)
        result[key] = value
    return result

def _reject_nonfinite(token):
    raise ContractError("non-finite JSON token: " + token)

def validate_raw(raw):
    """Parse bounded, canonical UTF-8 JSON without trusting metadata as compiler proof."""
    if type(raw) is not bytes or not raw or len(raw) > 128 * 1024:
        raise ContractError("invalid or oversized contract bytes")
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ContractError("UTF-8 BOM is forbidden")
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_json_pairs,
                          parse_constant=_reject_nonfinite)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ContractError("invalid canonical contract JSON: " + str(exc)) from exc
    return validate(data)

def validate(document):
    if type(document) is not dict or set(document) != {"contract", "status", "backend_order", "backend_capabilities", "rules", "vectors"}:
        raise ContractError("top-level contract keys or type mismatch")
    if document.get("contract") != "oreslang.private-abstract-actor-hook.v1":
        raise ContractError("wrong contract identifier")
    if document.get("status") != "normative_expected_not_compiler_evidence":
        raise ContractError("manifest cannot claim compiled evidence")
    if type(document.get("backend_order")) is not list or tuple(document["backend_order"]) != EXPECTED_BACKENDS:
        raise ContractError("missing, reordered or duplicate backend")
    matrix = document.get("backend_capabilities")
    if not isinstance(matrix, dict) or set(matrix) != set(EXPECTED_BACKENDS):
        raise ContractError("backend capability matrix incomplete")
    for backend, expected_status in EXPECTED_STATUS.items():
        entry = matrix[backend]
        if type(entry) is not dict or entry != EXPECTED_CAPABILITIES[backend] or entry.get("status") != expected_status:
            raise ContractError("backend capability declaration drift: " + backend)
    rules = document.get("rules")
    if type(rules) is not list or any(type(rule) is not str for rule in rules) or len(rules) != len(set(rules)) or set(rules) != REQUIRED_RULES:
        raise ContractError("required authority/evidence rules are missing or duplicated")
    vectors = document.get("vectors")
    if not isinstance(vectors, list) or len(vectors) != len(EXPECTED_VECTORS):
        raise ContractError("source vector count changed")
    seen = set()
    for item in vectors:
        if type(item) is not dict or set(item) != {"id", "scope", "expected", "diagnostic", "source"}:
            raise ContractError("invalid source vector shape")
        identifier = item.get("id")
        if type(identifier) is not str or identifier not in EXPECTED_VECTORS or identifier in seen:
            raise ContractError("unknown or duplicate source vector: " + str(identifier))
        seen.add(identifier)
        expected = "accept" if identifier in EXPECTED_ACCEPT else "reject"
        if item.get("expected") != expected:
            raise ContractError("expected acceptance was changed: " + identifier)
        scope = "actor" if identifier.startswith("actor_") else "class"
        if item.get("scope") != scope:
            raise ContractError("source scope changed: " + identifier)
        source = item.get("source")
        if type(source) is not str or not source.strip() or "define " not in source:
            raise ContractError("missing executable source fixture: " + identifier)
        diagnostic = item.get("diagnostic")
        if type(diagnostic) is not str or not diagnostic.strip():
            raise ContractError("missing diagnostic classification: " + identifier)
        if {"source": source, "diagnostic": diagnostic} != EXPECTED_FIXTURES[identifier]:
            raise ContractError("source/diagnostic mutated without baseline review: " + identifier)
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
        result = validate_raw(read_manifest_bounded(args.manifest))
    except (OSError, ValueError, TypeError) as exc:
        parser.exit(2, "PRIVATE_ABSTRACT_ACTOR_HOOK_INVALID: " + str(exc) + "\n")
    if args.require_compiler_evidence:
        parser.exit(3, "PRIVATE_ABSTRACT_ACTOR_HOOK_NOT_EXECUTED: run exact-tree real compiler tests\n")
    print(json.dumps({"backend": args.backend, **result}, sort_keys=True))

if __name__ == "__main__":
    main()
