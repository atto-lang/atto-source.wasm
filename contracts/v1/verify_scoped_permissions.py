#!/usr/bin/env python3
"""Validate canonical permission vectors and REAL-backend report completeness.

This is a gate, not a permission evaluator. It cannot prove a report came
from guest execution: separate CI provenance and native boundary tests must.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

SCHEMA = "oreslang.scoped-permissions.v1"
REPORT_SCHEMA = "oreslang.scoped-permissions.report.v1"
BACKENDS = {"llvm", "net", "wasm", "forge", "java"}
SHA = re.compile(r"[0-9a-f]{40}")
VALID_DECISIONS = {"allow", "deny", "accept", "reject"}
CANONICAL_VECTORS_SHA256 = "b481b72d9e5fdb2c1a4d4de7745a02f7ec3af8a937b0f067885d184efc3cb308"

def pairs_no_duplicates(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON key: " + key)
        obj[key] = value
    return obj

def read_json(path):
    p = Path(path)
    if p.is_symlink() or not p.is_file():
        raise ValueError("missing, nonregular, or symlinked conformance JSON")
    if p.stat().st_size > 1024 * 1024:
        raise ValueError("oversized conformance data")
    return json.loads(p.read_text(encoding="utf-8"), object_pairs_hook=pairs_no_duplicates)

def check_canonical_vectors(path):
    """Reject a changed allow/deny oracle even if its JSON schema is valid.

    This check cannot prove backend execution or establish runtime parity.
    """
    p = Path(path)
    if p.is_symlink() or not p.is_file():
        raise ValueError("missing, nonregular, or symlinked conformance JSON")
    raw = p.read_bytes()
    if len(raw) > 1024 * 1024:
        raise ValueError("oversized conformance data")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != CANONICAL_VECTORS_SHA256:
        raise ValueError("canonical permission vectors SHA-256 mismatch")
    # Parse exactly the bytes that were checked. A second path read creates
    # a digest-then-use race if a workspace file changes concurrently.
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs_no_duplicates)

def load_vectors(path, *, enforce_digest=False):
    data = check_canonical_vectors(path) if enforce_digest else read_json(path)
    if not isinstance(data, dict):
        raise ValueError("permission corpus must be a JSON object")
    if data.get("schema") != SCHEMA or type(data.get("version")) is not int or data["version"] != 1:
        raise ValueError("wrong permission corpus schema")
    if sorted(data.get("backends", [])) != sorted(BACKENDS):
        raise ValueError("backend coverage mismatch")
    cases = data.get("cases")
    if not isinstance(cases, list) or len(cases) < 30:
        raise ValueError("missing permission conformance cases")
    ids = {}
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("permission case must be an object")
        cid, kind, expected = case.get("id"), case.get("kind"), case.get("expected")
        if not isinstance(cid, str) or not re.fullmatch(r"[a-z0-9-]+", cid):
            raise ValueError("invalid case identifier")
        if cid in ids:
            raise ValueError("duplicate case identifier: " + cid)
        if kind == "authorize":
            if expected not in ("allow", "deny") or case.get("permission") not in (
                "read", "write", "net", "env", "run", "sys", "ffi", "import"
            ):
                raise ValueError("invalid authorization expectation: " + cid)
            if type(case.get("coarse")) is not bool or not isinstance(case.get("resource"), str):
                raise ValueError("invalid authorization scope: " + cid)
            if not all(isinstance(case.get(key), list) and all(
                    isinstance(x, str) for x in case[key]) for key in ("allow", "deny")):
                raise ValueError("invalid authorization rule: " + cid)
        elif kind == "deserialize":
            if expected not in ("accept", "reject") or not isinstance(case.get("argv"), list):
                raise ValueError("invalid serialized policy: " + cid)
            if not all(isinstance(x, str) for x in case["argv"]):
                raise ValueError("invalid serialized argv: " + cid)
        else:
            raise ValueError("invalid case kind: " + cid)
        ids[cid] = expected
    return ids

def validate_report(report, backend, ids, source_commit, source_tree):
    if not isinstance(report, dict):
        raise ValueError("runtime report must be an object")
    # Callers may use this validator directly, without the CLI argument gate.
    # Never let an unpinned or malformed source identity count as evidence.
    if not all(isinstance(value, str) and SHA.fullmatch(value)
               for value in (source_commit, source_tree)):
        raise ValueError("invalid source commit/tree identifiers")
    if report.get("schema") != REPORT_SCHEMA or report.get("backend") != backend:
        raise ValueError("wrong backend report schema")
    if report.get("source_commit") != source_commit or report.get("source_tree") != source_tree:
        raise ValueError("source commit/tree mismatch")
    execution = report.get("execution")
    if not isinstance(execution, dict) or not all(
            isinstance(execution.get(k), str) and execution[k].strip()
            for k in ("runner", "command", "url")):
        raise ValueError("missing real execution metadata")
    results = report.get("results")
    if not isinstance(results, list) or len(results) != len(ids):
        raise ValueError("incomplete runtime result count")
    seen = set()
    for result in results:
        if not isinstance(result, dict):
            raise ValueError("runtime result must be an object")
        # A report with executed=true and a conflicting status=skipped,
        # pending=true or error marker is not unambiguous execution proof.
        # v1 intentionally has just three result fields. Any extensions
        # require a reviewed schema revision across all five backends.
        if set(result) != {"id", "decision", "executed"}:
            raise ValueError("unexpected runtime result fields")
        cid = result.get("id")
        if cid not in ids or cid in seen:
            raise ValueError("unexpected/duplicate test case")
        seen.add(cid)
        if result.get("executed") is not True:
            raise ValueError("skipped or synthetic test: " + cid)
        if result.get("decision") != ids[cid]:
            raise ValueError("permission mismatch in " + cid)
    if seen != ids.keys():
        raise ValueError("some required permission cases were not executed")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--vectors", default=str(Path(__file__).with_name("scoped-permissions-v1.json")))
    p.add_argument("--validate-only", action="store_true")
    p.add_argument("--backend", choices=sorted(BACKENDS))
    p.add_argument("--report")
    p.add_argument("--source-commit")
    p.add_argument("--source-tree")
    args = p.parse_args()
    try:
        ids = load_vectors(args.vectors, enforce_digest=True)
        if args.validate_only:
            if args.report or args.backend or args.source_commit or args.source_tree:
                raise ValueError("validate-only cannot claim runtime evidence")
            print(f"VECTOR_SCHEMA_OK {len(ids)} cases; RUNTIME_PARITY_NOT_VERIFIED")
            return 0
        if not all((args.backend, args.report, args.source_commit, args.source_tree)):
            raise ValueError("runtime report requires backend, report, commit and tree")
        for key in (args.source_commit, args.source_tree):
            if not SHA.fullmatch(key):
                raise ValueError("invalid immutable 40-hex Git identifier")
        validate_report(read_json(args.report), args.backend, ids,
                        args.source_commit, args.source_tree)
        print(f"BACKEND_REPORT_COMPLETE backend={args.backend} cases={len(ids)}"
              " (independent CI provenance required)")
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"PERMISSION_PARITY_GATE_FAILED: {exc}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
