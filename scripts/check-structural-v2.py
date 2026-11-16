#!/usr/bin/env python3
"""Structural positional tuple v2 contract integrity only; NOT guest parity."""
import argparse
import copy
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
README = "contracts/structural/v2/README.md"
CASES = "contracts/structural/v2/cases.json"
README_SHA = "1a61b6267fd2185879628d7879db05804698a310"
CASES_SHA = "57c80adaa4029c6fd3e46a63c490cb193f951568"
BACKENDS = ["java", "llvm", "net", "wasm", "forge"]
EXPECTED = (
    "syn.explicit:accept syn.shorthand:accept syn.structural:accept "
    "syn.optional.middle:reject syn.optional.value:accept "
    "shape.two:accept shape.three:accept shape.four:accept shape.direct:accept "
    "shape.one:reject shape.wrong.required:reject shape.wrong.optional:reject "
    "shape.exact.extra:reject shape.non.tuple:reject shape.unknown.spread:reject "
    "shape.private.extra:reject overload.arity.first:accept "
    "overload.same.arity:reject overload.primitive:reject "
    "overload.ambiguous.pack:reject safety.mutable:reject safety.async:reject "
    "safety.actor:reject safety.fixed.array:reject safety.eval.once:accept "
    "safety.no.implicit.pack:reject safety.tuple.width.65:reject "
    "safety.family.size.129:reject safety.unknown.slot:reject "
    "safety.mutable.borrow.slot:reject"
)
EXPECTED_PAIRS = [tuple(x.split(":", 1)) for x in EXPECTED.split()]

class Failure(Exception):
    pass

def require(ok, message):
    if not ok:
        raise Failure(message)

def unique_pairs(pairs):
    result = {}
    for k, v in pairs:
        require(k not in result, "duplicate JSON key: " + k)
        result[k] = v
    return result

def decode(raw):
    try:
        document = json.loads(raw, object_pairs_hook=unique_pairs,
                          parse_constant=lambda v: (_ for _ in ()).throw(
                              Failure("nonfinite JSON: " + v)))
        require(type(document) is dict, "manifest JSON must be an object")
        return document
    except (ValueError, TypeError) as ex:
        raise Failure("malformed JSON: " + str(ex)) from ex

def blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") +
                        b"\0" + data).hexdigest()

def verify(document, readme_bytes, manifest_bytes):
    require(blob_sha(readme_bytes) == README_SHA, "v2 README Git blob drift")
    require(blob_sha(manifest_bytes) == CASES_SHA, "v2 cases Git blob drift")
    require(type(document) is dict and
            set(document) == {"contract", "status", "backend_ids", "cases"},
            "unexpected v2 manifest schema")
    require(document["contract"] == "oreslang.structural-positional-tuple.v2",
            "v2 contract name changed")
    require(document["status"] == "target-only", "runtime parity promoted without proof")
    require(document["backend_ids"] == BACKENDS, "backend order/scope drift")
    cases = document["cases"]
    require(type(cases) is list and len(cases) == len(EXPECTED_PAIRS),
            "missing or extra v2 case")
    for index, (case, expected) in enumerate(zip(cases, EXPECTED_PAIRS)):
        require(type(case) is dict and
                set(case) == {"id", "expect", "source", "reason"},
                "invalid v2 case fields: " + str(index))
        require((case["id"], case["expect"]) == expected,
                "changed v2 case identity/order/outcome: " + str(index))
        for field in ("source", "reason"):
            require(type(case[field]) is str and bool(case[field].strip()),
                    "missing v2 " + field + ": " + str(index))
    return len(cases)

def load(root):
    try:
        readme = (root / README).read_bytes()
        manifest = (root / CASES).read_bytes()
    except OSError as ex:
        raise Failure("missing v2 contract: " + str(ex)) from ex
    data = decode(manifest.decode("utf-8"))
    verify(data, readme, manifest)
    return data, readme, manifest

def self_test(root):
    data, readme, manifest = load(root)
    mutations = []
    def tamper(fn):
        changed = copy.deepcopy(data)
        fn(changed)
        mutations.append((changed, readme, manifest))
    tamper(lambda d: d["cases"].pop())
    tamper(lambda d: d["cases"].append(copy.deepcopy(d["cases"][0])))
    tamper(lambda d: d["cases"].reverse())
    tamper(lambda d: d["cases"][0].update(expect="reject"))
    tamper(lambda d: d["cases"][0].update(source=""))
    tamper(lambda d: d.update(status="verified"))
    tamper(lambda d: d["backend_ids"].remove("forge"))
    tamper(lambda d: d.update(unknown="unreviewed"))
    mutations.append((copy.deepcopy(data), readme + b"\n", manifest))
    mutations.append((copy.deepcopy(data), readme, manifest + b"\n"))
    for index, (doc, md, js) in enumerate(mutations):
        try:
            verify(doc, md, js)
        except Failure:
            continue
        raise Failure("tampering escaped v2 gate: " + str(index))
    for raw in ('{"id":"x","id":"x"}', 'NaN', '[]', '{"x":Infinity}'):
        try:
            decode(raw)
        except Failure:
            continue
        raise Failure("malformed v2 JSON accepted: " + raw)
    return len(mutations) + 4

def main():
    cli = argparse.ArgumentParser()
    group = cli.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--self-test", action="store_true")
    group.add_argument("--require-parity", action="store_true")
    args = cli.parse_args()
    try:
        if args.self_test:
            print("v2: rejected " + str(self_test(ROOT)) + " adversarial mutations")
        else:
            _, md, raw = load(ROOT)
            print("v2: 30 cases, 5 backends, pinned blobs validated")
            if args.require_parity:
                raise Failure("NOT AT PARITY: v2 contract status is target-only")
            print("v2: INTEGRITY ONLY; NOT executed structural guest parity")
        return 0
    except (Failure, UnicodeError) as ex:
        print("STRUCTURAL V2 AUDIT FAILED: " + str(ex), file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
