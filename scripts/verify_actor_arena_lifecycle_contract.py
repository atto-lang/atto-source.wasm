#!/usr/bin/env python3
"""Fail-closed validation of the actor-arena lifecycle evidence contract.

A pass proves only that all five backends declare the same conservative
lifecycle/evidence policy. It does not certify guest or native execution.
"""
import json
import math
from pathlib import Path
import sys

BACKENDS = ("java", "llvm", "net", "wasm", "forge")
FIELDS = (
    "logical_termination", "authority_revocation", "byte_scrub",
    "physical_reclamation", "scratch_turn_revocation", "incarnation_fencing",
    "foreign_carrier_denial", "guest_capability_fabrication_denial", "nonrecycling_identity",
    "guest_allocation_lowering", "ffi_borrow_io_quiescence",
    "exact_head_native_evidence",
)
EXPECTED_ORDER = [
    "logical-termination", "authority-revocation", "byte-scrub",
    "physical-reclamation",
]
EXPECTED_CASES = {
    "done-is-not-reclaimed": "separate-states",
    "revoke-before-scrub": "ordered",
    "scrub-before-reclaim": "ordered",
    "scratch-dies-at-turn-end": "deny-stale",
    "stale-incarnation-denied": "deny-stale",
    "foreign-carrier-denied": "deny",
    "raw-guest-capability-coordinates-denied": "deny-fabrication",
    "malformed-owner-does-not-consume-identity": "no-consumption",
    "identity-never-wraps-or-recycles": "fail-closed",
    "identity-exhaustion-is-permanent": "fail-closed",
    "borrow-quiescence-before-reclaim": "required",
    "ffi-quiescence-before-reclaim": "required",
    "io-quiescence-before-reclaim": "required",
    "java-no-deterministic-physical-release-claim": "runtime-dependent",
    "wasm-no-deterministic-physical-release-claim": "runtime-dependent",
    "llvm-native-reclaim-needs-exact-head-proof": "pending-evidence",
    "net-native-reclaim-needs-exact-head-proof": "pending-evidence",
    "forge-native-reclaim-needs-exact-head-proof": "pending-evidence",
    "guest-allocation-lowering-needs-proof": "pending-evidence",
    "native-job-must-execute-steps": "nonzero-steps",
    "receipt-must-bind-head-and-tree": "authenticated",
}
SOURCE = "source-implemented-unverified"
RUNTIME_DEPENDENT = "runtime-dependent-not-certifiable"
UNVERIFIED = "unverified"
PENDING = "pending"

class ContractError(ValueError):
    pass

def _pairs(items):
    out = {}
    for key, value in items:
        if key in out:
            raise ContractError("duplicate JSON key: " + key)
        out[key] = value
    return out

def _constant(value):
    raise ContractError("non-finite JSON number: " + value)

def _float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ContractError("non-finite JSON float")
    return value

def validate_raw(raw):
    if type(raw) is not bytes or not raw or len(raw) > 64 * 1024:
        raise ContractError("invalid or oversized lifecycle contract")
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ContractError("BOM forbidden")
    try:
        doc = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                         parse_constant=_constant, parse_float=_float)
    except ContractError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ContractError("invalid canonical UTF-8 JSON") from exc
    validate(doc)
    return doc

def require(cond, msg):
    if not cond:
        raise ContractError(msg)

def validate(doc):
    require(type(doc) is dict, "top-level lifecycle contract must be object")
    require(set(doc) == {"contract", "version", "scope", "lifecycle_order",
                         "backend_support", "cases"},
            "unknown or missing lifecycle fields")
    require(doc["contract"] == "oreslang-actor-arena-lifecycle-v1"
            and type(doc["version"]) is int and doc["version"] == 1,
            "lifecycle identity/version mismatch")
    require(doc["scope"] ==
            "source-level lifecycle capability declarations and fail-closed evidence requirements; not guest/runtime parity certification",
            "scope must remain non-certifying")
    require(doc["lifecycle_order"] == EXPECTED_ORDER,
            "logical termination/revocation/scrub/reclamation order drift")
    support = doc["backend_support"]
    require(type(support) is dict and tuple(sorted(support)) == tuple(sorted(BACKENDS)),
            "all five backends require explicit lifecycle status")
    for backend in BACKENDS:
        claims = support[backend]
        require(type(claims) is dict and tuple(claims) == FIELDS,
                "backend lifecycle capability shape drift: " + backend)
        for field in ("logical_termination", "authority_revocation", "byte_scrub",
                      "scratch_turn_revocation", "incarnation_fencing",
                      "foreign_carrier_denial", "guest_capability_fabrication_denial",
                      "nonrecycling_identity"):
            require(claims[field] == SOURCE,
                    "unreviewed lifecycle promotion/demotion: " + backend + "/" + field)
        require(claims["guest_allocation_lowering"] == UNVERIFIED,
                "guest allocation lowering cannot be promoted by source-only contract")
        require(claims["ffi_borrow_io_quiescence"] == UNVERIFIED,
                "quiescence cannot be promoted by source-only contract")
        require(claims["exact_head_native_evidence"] == PENDING,
                "native certification requires exact-head executed evidence")
        expected_reclaim = RUNTIME_DEPENDENT if backend in ("java", "wasm") else SOURCE
        require(claims["physical_reclamation"] == expected_reclaim,
                "physical reclamation capability overclaim: " + backend)
    cases = doc["cases"]
    require(type(cases) is list and len(cases) == len(EXPECTED_CASES),
            "lifecycle case count drift")
    seen = set()
    for item in cases:
        require(type(item) is dict and set(item) == {"id", "expect"},
                "lifecycle case shape drift")
        ident = item["id"]
        require(type(ident) is str and ident in EXPECTED_CASES and ident not in seen,
                "unknown or duplicate lifecycle case")
        require(type(item["expect"]) is str and item["expect"] == EXPECTED_CASES[ident],
                "lifecycle expectation drift: " + ident)
        seen.add(ident)
    require(seen == set(EXPECTED_CASES), "missing lifecycle case")

if __name__ == "__main__":
    path = Path(sys.argv[1]) if len(sys.argv) == 2 else (
        Path(__file__).resolve().parents[1] /
        "contracts/v1/actor_arena_lifecycle_v1.json")
    try:
        validate_raw(path.read_bytes())
    except (OSError, ContractError) as exc:
        print("ACTOR_ARENA_LIFECYCLE_DENIED: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
    print("ACTOR_ARENA_LIFECYCLE_PASS: backends=5 cases=21 policy_only=true")
