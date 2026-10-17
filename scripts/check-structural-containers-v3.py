#!/usr/bin/env python3
"""Fail-closed structural collection v3 contract inventory. NOT guest evidence."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "contracts/structural/v3/cases.json"
README = ROOT / "contracts/structural/v3/README.md"
EXPECTED_BLOBS = {
    "cases": "6761f60b3e3bd2ac03c09aa25741f953db79c3cd",
    "readme": "a2c229cb5c92dfeba9cb045e20b3b60ea0e20244",
}
EXPECTED_IDS = frozenset("""
array.homogeneous array.literal array.mismatch array.dynamic.to.fixed
array.no.list.coercion array.readonly.set array.numeric.coercion array.unknown
array.hidden.mutable fixedarray.extent fixedarray.wrong.extent
fixedarray.zero.element.identity fixedarray.not.tuple fixedarray.bound.65 list.readonly
list.literal.covariance list.writable.covariance list.not.array
list.push list.unknown list.nested.mutable fixedlist.extent
fixedlist.wrong.extent fixedlist.zero.element.identity map.readonly map.value.literal map.key.invariant
map.value.numeric map.unknown.key map.unknown.value map.mutable.put
map.unsafe.key map.nested.mutable capability.no_escape
capability.no_await overload.no_shape_only spread.no_dynamic_container
map.key.optional
""".split())
BACKENDS = ["java", "llvm", "net", "wasm", "forge"]


def require(ok, message):
    if not ok:
        raise ValueError("structural collection v3 inventory rejected: " + message)


def git_blob(content):
    return hashlib.sha1(b"blob " + str(len(content)).encode("ascii")
                        + b"\x00" + content).hexdigest()


def validate(data):
    require(type(data) is dict and set(data) ==
            {"contract", "status", "backend_ids", "max_fixed_extent", "notice", "cases"},
            "unexpected top-level schema")
    require(data["contract"] == "oreslang.structural-containers.v3",
            "unexpected contract version")
    require(data["status"] == "target-only", "inventory falsely claims implementation")
    require(data["backend_ids"] == BACKENDS, "backend identity or order mismatch")
    require(type(data["max_fixed_extent"]) is int and data["max_fixed_extent"] == 64,
            "invalid finite extent bound")
    require(type(data["notice"]) is str
            and "not" in data["notice"].lower(), "missing evidence disclaimer")
    cases = data["cases"]
    require(type(cases) is list and len(cases) == 38,
            "missing or added decision cases")
    found = set()
    accept = reject = 0
    for case in cases:
        require(type(case) is dict and set(case) == {"id", "expect", "source", "reason"},
                "invalid decision schema")
        name, expected = case["id"], case["expect"]
        require(type(name) is str and name in EXPECTED_IDS
                and name not in found, "unknown or duplicated case")
        found.add(name)
        require(expected in ("accept", "reject") and type(expected) is str,
                "missing or invalid decision")
        require(type(case["source"]) is str and case["source"].strip(),
                "empty source")
        require(type(case["reason"]) is str and case["reason"].strip(),
                "empty decision rationale")
        accept += expected == "accept"
        reject += expected == "reject"
    require(found == EXPECTED_IDS and accept == 9 and reject == 29,
            "structural cases missing or approval/rejection counts drift")
    require(all(any(name.startswith(prefix) for name in found)
                for prefix in ("array.", "fixedarray.", "list.", "fixedlist.",
                               "map.", "capability.", "spread.", "overload.")),
            "collection family coverage missing")
    return {"contract": data["contract"], "status": data["status"],
            "cases": len(cases), "accepted_targets": accept, "rejected_targets": reject,
            "runtime_verified": False, "source_exported": False}


def self_test():
    original = json.loads(CASES.read_text(encoding="utf-8"))
    validate(original)
    tests = []
    altered = json.loads(json.dumps(original))
    altered["status"] = "implemented"
    tests.append(altered)
    altered = json.loads(json.dumps(original))
    altered["cases"].pop()
    tests.append(altered)
    altered = json.loads(json.dumps(original))
    altered["cases"][0]["expect"] = "reject"
    tests.append(altered)
    altered = json.loads(json.dumps(original))
    altered["cases"][0]["id"] = altered["cases"][1]["id"]
    tests.append(altered)
    altered = json.loads(json.dumps(original))
    altered["backend_ids"].pop()
    tests.append(altered)
    altered = json.loads(json.dumps(original))
    altered["max_fixed_extent"] = 65
    tests.append(altered)
    for i, forged in enumerate(tests):
        try:
            validate(forged)
        except ValueError:
            continue
        raise AssertionError("malformed structural v3 fixture accepted: " + str(i))
    print("structural containers v3: 6 synthetic tamper cases rejected")


def main():
    p = argparse.ArgumentParser()
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--self-test", action="store_true")
    group.add_argument("--require-parity", action="store_true")
    args = p.parse_args()
    if args.require_parity:
        raise SystemExit("NOT AT PARITY: structural arrays/lists/maps need executable guest proof")
    raw, description = CASES.read_bytes(), README.read_bytes()
    require(git_blob(raw) == EXPECTED_BLOBS["cases"], "case Git blob changed")
    require(git_blob(description) == EXPECTED_BLOBS["readme"], "README Git blob changed")
    data = json.loads(raw)
    if args.self_test:
        self_test()
    else:
        print(json.dumps(validate(data), sort_keys=True))
        print("STRUCTURAL_COLLECTIONS_TARGET_ONLY_NOT_GUEST_CERTIFICATION")


if __name__ == "__main__":
    main()
