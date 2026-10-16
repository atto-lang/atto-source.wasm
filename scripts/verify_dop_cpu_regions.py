#!/usr/bin/env python3
"""Validate a shared DOP CPU region contract and strictly typed backend report.

This does NOT execute a compiler or authenticate CI links. Only actual backend
runners may provide evidence; a well-formed report is not runtime parity.
"""
import argparse
import json
import re
from pathlib import Path

CONTRACT = Path(__file__).resolve().parents[1] / "contracts/v1/dop-cpu-regions/cases.json"
BACKENDS = {"java", "llvm", "net", "wasm", "forge"}
ID = re.compile(r"^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$")
SHA = re.compile(r"^[0-9a-f]{40}$")
RUN = re.compile(r"^https://github\.com/[^/]+/[^/]+/actions/runs/[0-9]+$")

def require(predicate, reason):
    if not predicate:
        raise ValueError(reason)

def check_contract(contract):
    require(type(contract) is dict, "contract must be an object")
    require(contract.get("contract") == "oreslang.dop.cpu-regions"
            and contract.get("version") == 1, "unexpected DOP contract version")
    shape = contract.get("shape")
    require(type(shape) is dict and shape.get("scalar_bytes") == 4
            and shape.get("alignment") == 16 and shape.get("fields") == 3
            and shape.get("rows") == 7 and shape.get("aosoa_lanes") == 4
            and shape.get("layouts") == ["AoS", "SoA", "AoSoA"], "unrecognized ABI shape")
    require(contract.get("effects") == ["READ", "WRITE", "DISCARD", "REDUCE", "ATOMIC"],
            "unrecognized effect vocabulary")
    cases = contract.get("cases")
    require(type(cases) is list and len(cases) == 22, "expected exactly 22 DOP cases")
    ids = []
    for case in cases:
        require(type(case) is dict and set(case) == {"id", "domain", "expected"},
                "case must use only normative fields")
        require(type(case["id"]) is str and ID.fullmatch(case["id"]),
                "invalid case identifier")
        require(case["expected"] in {"valid", "reject"}, "invalid case expectation")
        require(case["domain"] in {"layout", "ownership", "loans", "execute",
                                    "scheduler", "gpu-boundary"}, "invalid case domain")
        ids.append(case["id"])
    require(len(set(ids)) == len(ids), "duplicate DOP case ID")
    return ids

def check_report(report, case_ids):
    require(type(report) is dict
            and set(report) == {"contract", "version", "backend", "implementation", "cases"},
            "report requires exact top-level fields")
    require(report["contract"] == "oreslang.dop.cpu-regions" and report["version"] == 1,
            "report targets wrong contract")
    require(report["backend"] in BACKENDS, "unknown backend")
    require(report["implementation"] in {"unsupported", "partial", "implemented"},
            "invalid implementation claim")
    records = report["cases"]
    require(type(records) is list and len(records) == len(case_ids),
            "report must enumerate every contract case exactly once")
    seen = set()
    passed = 0
    for item in records:
        require(type(item) is dict and set(item) == {
            "id", "status", "executed", "passed", "evidence"
        }, "missing or contradictory case metadata")
        name = item["id"]
        require(name in case_ids and name not in seen, "unknown or duplicate case")
        seen.add(name)
        require(item["status"] in {"pass", "unsupported"}, "ambiguous report status")
        require(type(item["executed"]) is bool and type(item["passed"]) is bool,
                "executed and passed must be booleans")
        evidence = item["evidence"]
        require(type(evidence) is list, "case evidence must be a list")
        if item["status"] == "pass":
            require(item["executed"] and item["passed"] and len(evidence) >= 1,
                    "passing case must actually execute and carry evidence")
            for proof in evidence:
                require(type(proof) is dict and set(proof) == {
                    "source_commit", "run_url", "backend"
                }, "invalid evidence object")
                require(proof["backend"] == report["backend"],
                        "cross-backend evidence is not executable parity")
                require(type(proof["source_commit"]) is str
                        and SHA.fullmatch(proof["source_commit"]), "missing exact source SHA")
                require(type(proof["run_url"]) is str and RUN.fullmatch(proof["run_url"]),
                        "missing canonical GitHub Actions run link")
            passed += 1
        else:
            require(item["executed"] is False and item["passed"] is False
                    and evidence == [], "unsupported case cannot claim execution")
    require(set(case_ids) == seen, "some cases omitted from report")
    claim = report["implementation"]
    require((claim == "unsupported" and passed == 0)
            or (claim == "partial" and 0 < passed < len(case_ids))
            or (claim == "implemented" and passed == len(case_ids)),
            "backend implementation status contradicts observed case statuses")
    return passed

def self_test(contract):
    names = check_contract(contract)
    # Fixtures intentionally use synthetic evidence, never a real parity claim.
    pending = [{"id": name, "status": "unsupported", "executed": False,
                "passed": False, "evidence": []} for name in names]
    example = {"contract": "oreslang.dop.cpu-regions", "version": 1,
               "backend": "java", "implementation": "unsupported", "cases": pending}
    require(check_report(example, names) == 0, "baseline negative evidence rejected")
    import copy
    def must_reject(mutator):
        copy_report = copy.deepcopy(example)
        mutator(copy_report)
        try:
            check_report(copy_report, names)
        except ValueError:
            return
        raise AssertionError("report validator admitted a contradictory parity claim")
    must_reject(lambda r: r["cases"][0].update(status="pass"))
    must_reject(lambda r: r["cases"][0].update(skipped=True))
    must_reject(lambda r: r["cases"][0].update(executed=True))
    must_reject(lambda r: r["cases"][0].update(id=names[1]))
    must_reject(lambda r: r.update(implementation="implemented"))
    print("DOP CPU v1: 22 contract cases, 5 fail-closed report mutants PASS")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, help="backend execution report JSON")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    names = check_contract(contract)
    if args.self_test:
        self_test(contract)
    if args.report:
        report = json.loads(args.report.read_text(encoding="utf-8"))
        count = check_report(report, names)
        print(f"DOP CPU v1: validated report structure, {count}/{len(names)} recorded passes")
        print("Note: report validation does not independently authenticate execution evidence")
    elif not args.self_test:
        print(f"DOP CPU v1: {len(names)} well-formed contract cases (NOT runtime parity)")

if __name__ == "__main__":
    main()
