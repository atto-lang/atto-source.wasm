#!/usr/bin/env python3
"""Fail-closed source-free validation for actor arena quiescence v1."""
import copy
import json
from pathlib import Path
import sys

BACKENDS = ("java", "llvm", "net", "wasm", "forge")
STAGES = {
    "java": "candidate-ffm-lifetime-pin",
    "llvm": "candidate-native-generation-lease",
    "net": "candidate-unmanaged-external-lease",
    "wasm": "candidate-fixed-page-pool-external-lease",
    "forge": "candidate-native-raii-external-lease",
}
INVARIANTS = (
    "logical-retirement-revokes-arena-authority-immediately",
    "physical-reclaim-waits-for-active-turns",
    "physical-reclaim-waits-for-live-borrows-if-supported",
    "physical-reclaim-waits-for-external-lifetime-owners",
    "external-lifetime-authority-grants-no-memory-access",
    "external-release-may-run-off-carrier",
    "external-release-is-idempotent-and-retry-safe",
    "stale-external-authority-cannot-release-newer-owner",
    "reclaim-failure-never-publishes-capacity-or-false-success",
    "reused-capacity-is-zeroized-before-admission",
    "ownership-and-quota-accounting-fails-closed",
    "source-free-pass-does-not-promote-runtime-certification",
)
SCOPE = (
    "source-free cross-backend reclamation semantics; not guest lowering, "
    "native AOT, exact-head CI, or zero-GC certification"
)

class ContractError(ValueError):
    pass

def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ContractError("duplicate JSON key: " + key)
        out[key] = value
    return out

def validate_raw(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > 64 * 1024:
        raise ContractError("invalid quiescence contract bytes")
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ContractError("BOM forbidden")
    try:
        doc = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ContractError("invalid canonical UTF-8 JSON") from exc
    validate(doc)
    return doc

def validate(doc):
    if type(doc) is not dict or set(doc) != {
        "contract", "version", "scope", "required_invariants", "backend_support"
    }:
        raise ContractError("unknown or missing top-level fields")
    if doc["contract"] != "oreslang-actor-arena-quiescence-v1" or doc["version"] != 1:
        raise ContractError("contract identity/version mismatch")
    if doc["scope"] != SCOPE:
        raise ContractError("scope must not promote runtime certification")
    if doc["required_invariants"] != list(INVARIANTS):
        raise ContractError("quiescence invariants drifted")
    support = doc["backend_support"]
    if type(support) is not dict or set(support) != set(BACKENDS):
        raise ContractError("all five backends require explicit support declarations")
    fields = {
        "candidate_stage", "candidate_quiescence_implementation",
        "guest_lowering_certified", "native_aot_certified",
        "exact_head_ci_certified", "zero_host_gc_certified",
    }
    for backend in BACKENDS:
        row = support[backend]
        if type(row) is not dict or set(row) != fields:
            raise ContractError("incomplete backend declaration: " + backend)
        if row["candidate_stage"] != STAGES[backend]:
            raise ContractError("candidate stage drift: " + backend)
        if row["candidate_quiescence_implementation"] is not True:
            raise ContractError("candidate implementation missing: " + backend)
        for flag in (
            "guest_lowering_certified", "native_aot_certified",
            "exact_head_ci_certified", "zero_host_gc_certified",
        ):
            if row[flag] is not False:
                raise ContractError("unverified certification promoted: " + backend + "/" + flag)
    return doc

def self_test(base):
    mutations = [
        lambda d: d["required_invariants"].pop(),
        lambda d: d["required_invariants"].reverse(),
        lambda d: d["backend_support"].pop("forge"),
        lambda d: d["backend_support"].update({"other": {}}),
        lambda d: d["backend_support"]["java"].update({"candidate_quiescence_implementation": False}),
        lambda d: d["backend_support"]["llvm"].update({"candidate_stage": "candidate-host-only"}),
        lambda d: d["backend_support"]["net"].update({"exact_head_ci_certified": True}),
        lambda d: d["backend_support"]["wasm"].update({"zero_host_gc_certified": True}),
        lambda d: d["backend_support"]["forge"].update({"native_aot_certified": True}),
        lambda d: d.update({"scope": "runtime certified"}),
    ]
    for index, mutate in enumerate(mutations, 1):
        candidate = copy.deepcopy(base)
        mutate(candidate)
        try:
            validate(candidate)
        except ContractError:
            continue
        raise ContractError("self-test mutation accepted: " + str(index))
    try:
        validate_raw(b'{"contract":"x","contract":"y"}')
    except ContractError:
        pass
    else:
        raise ContractError("duplicate-key self-test accepted")
    print("ACTOR_ARENA_QUIESCENCE_V1_SELFTEST_PASS: mutations=11")

def main():
    args = sys.argv[1:]
    selftest = False
    if "--self-test" in args:
        args.remove("--self-test")
        selftest = True
    if len(args) > 1:
        raise ContractError("usage: verify_actor_arena_quiescence_v1.py [--self-test] [path]")
    path = Path(args[0]) if args else (
        Path(__file__).resolve().parents[1] / "contracts/v1/actor_arena_quiescence_v1.json"
    )
    doc = validate_raw(path.read_bytes())
    if selftest:
        self_test(doc)
    print("ACTOR_ARENA_QUIESCENCE_V1_PASS: backends=5 invariants=12 source_free_only=true")

if __name__ == "__main__":
    try:
        main()
    except (OSError, ContractError) as exc:
        print("ACTOR_ARENA_QUIESCENCE_V1_DENIED: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
