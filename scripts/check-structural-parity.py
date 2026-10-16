#!/usr/bin/env python3
"""Fail-closed structural parity inventory, not a compiler conformance oracle.

This intentionally never promotes a backend to verified: that requires a later
independent guest-compile, execution and artifact-hash verification pipeline.
A passing invocation attests only that the shared inventory has not drifted.
"""
import argparse
import copy
import hashlib
import json
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTRACT = "contracts/v1/STRUCTURAL_MATCH_V1.md"
INVENTORY = "contracts/v1/structural-parity-audit.v1.json"
BLOB_SHA1 = "17f4da4a2cd3e55a968f9daf09395b000d79fc0b"
CASE_STAGES = (
    ("extra-public-members", ("typecheck", "execute")),
    ("nominal-not-implicit-structural", ("typecheck",)),
    ("missing-private-or-wrong-field", ("typecheck",)),
    ("method-signature-mode-effects", ("typecheck",)),
    ("function-routine-instance-static", ("typecheck", "execute")),
    ("declaration-metadata-orthogonal", ("parse", "typecheck")),
    ("named-inline-tuple-patterns", ("typecheck", "execute")),
    ("ordered-first-success-guard", ("typecheck", "execute")),
    ("unreachable-broad-before-narrow", ("typecheck",)),
    ("readonly-and-owner-reuse", ("ownership", "execute")),
    ("no-escape-await-or-actor-erasure", ("ownership",)),
    ("runtime-shape-fallback", ("execute",)),
    ("contextual-structural-identifier", ("parse", "execute")),
    ("real-guest-artifact-evidence", ("artifact", "execute")),
)
BACKENDS = {
    "java": "reference-partial",
    "llvm": "reject-only",
    "wasm": "conditional-reject-only",
    "net": "reject-only",
    "forge": "reject-only",
}
NOTICE = ("Conformance inventory only. A green audit is NOT compiled-guest "
          "structural parity. A release gate must fail until native evidence "
          "is independently checked.")


class AuditFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AuditFailure(message)


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise AuditFailure("duplicate JSON key: " + key)
        obj[key] = value
    return obj


def read_inventory(raw):
    try:
        data = json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              AuditFailure("nonfinite JSON number")))
    except (ValueError, TypeError) as exc:
        raise AuditFailure("malformed inventory JSON: " + str(exc)) from exc
    require(type(data) is dict, "inventory must be an object")
    return data


def verify(data, contract_bytes):
    require(set(data) == {"schema", "contract_git_blob_sha1", "cases",
                          "backends", "notice"}, "unexpected inventory root keys")
    require(data["schema"] == "oreslang.structural.parity.audit.v1",
            "invalid contract schema")
    require(data["notice"] == NOTICE, "missing non-parity disclaimer")
    require(data["contract_git_blob_sha1"] == BLOB_SHA1,
            "contract pin changed without audited update")
    git_blob = b"blob " + str(len(contract_bytes)).encode("ascii") + b"\0" + contract_bytes
    require(hashlib.sha1(git_blob).hexdigest() == BLOB_SHA1,
            "shared Markdown contract differs from the pinned Git blob")
    expected = [{"id": name, "stages": list(stages)} for name, stages in CASE_STAGES]
    require(type(data["cases"]) is list and data["cases"] == expected,
            "required case IDs, order or proof stages changed/omitted")
    require(type(data["backends"]) is dict and
            set(data["backends"]) == set(BACKENDS), "backend scope drift")
    for backend, capability in BACKENDS.items():
        item = data["backends"][backend]
        require(type(item) is dict and
                item == {"capability": capability, "runtime_evidence": "unverified"},
                backend + ": invented or silently promoted runtime evidence")
    return len(expected)


def check(root):
    try:
        contract_bytes = (root / CONTRACT).read_bytes()
        inventory = read_inventory((root / INVENTORY).read_text(encoding="utf-8"))
    except (OSError, UnicodeError) as exc:
        raise AuditFailure("missing/unreadable audit input: " + str(exc)) from exc
    return verify(inventory, contract_bytes)


def self_test(root):
    contract = (root / CONTRACT).read_bytes()
    clean = read_inventory((root / INVENTORY).read_text(encoding="utf-8"))
    verify(clean, contract)
    attacks = []
    def mutate(fn):
        changed = copy.deepcopy(clean)
        fn(changed)
        attacks.append((changed, contract))
    mutate(lambda d: d["cases"].pop())
    mutate(lambda d: d["cases"].append(copy.deepcopy(d["cases"][0])))
    mutate(lambda d: d["cases"][0]["stages"].pop())
    mutate(lambda d: d["cases"].reverse())
    mutate(lambda d: d["backends"].pop("wasm"))
    mutate(lambda d: d["backends"]["java"].update(runtime_evidence="verified"))
    mutate(lambda d: d["backends"]["llvm"].update(capability="complete"))
    mutate(lambda d: d.update(contract_git_blob_sha1="0" * 40))
    mutate(lambda d: d.update(extra="unreviewed"))
    attacks.append((copy.deepcopy(clean), contract + b"\n"))
    for index, (candidate, source) in enumerate(attacks):
        try:
            verify(candidate, source)
        except AuditFailure:
            continue
        raise AuditFailure("tampered inventory passed mutation " + str(index))
    for raw in ('{"a":1,"a":2}', 'NaN', '[]', '{"x":Infinity}'):
        try:
            parsed = read_inventory(raw)
            verify(parsed, contract)
        except AuditFailure:
            continue
        raise AuditFailure("malformed/duplicate JSON passed: " + raw)
    return len(attacks) + 4


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--self-test", action="store_true")
    modes.add_argument("--require-parity", action="store_true")
    args = parser.parse_args()
    try:
        if args.self_test:
            count = self_test(ROOT)
            print("OK: " + str(count) + " adversarial parity-inventory mutations rejected")
        else:
            count = check(ROOT)
            print("OK: " + str(count) + " mandatory cases, 5 backends and Git-blob pin intact")
            if args.require_parity:
                raise AuditFailure("NOT AT PARITY: no independent verified guest runtime evidence")
            print("STATUS: inventory-only; all five backends NOT AT PARITY")
    except AuditFailure as exc:
        print("STRUCTURAL PARITY AUDIT FAILED: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
