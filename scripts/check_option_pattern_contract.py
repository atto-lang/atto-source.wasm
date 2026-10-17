#!/usr/bin/env python3
"""Shared Option pattern admission gate. Rejection is NOT implementation parity.

All backends use identical source vectors and this fail-closed probe. The native
bootstrap backends must reject unsupported syntax without outputting LLVM IR.
The Java reference may accept/reject per the semantic oracle. A source-only
Wasm manifest check is explicitly PENDING, never executable compiler evidence.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "contracts" / "v1" / "option-pattern-v1.json"
ORACLES = {
    "some.foo": "accept",
    "none.fallback": "accept",
    "and.refinement": "accept",
    "scope.after-fi": "reject",
    "scope.else": "reject",
    "scope.or": "reject",
    "no-implicit-option": "reject",
    "ownership.projected-double-move": "reject",
    "ownership.projected-copy": "accept",
}
STATUS = {
    "graal": "implementation_under_test_no_pass_without_executed_evidence",
    "llvm": "unsupported_must_reject_without_ir",
    "net": "unsupported_must_reject",
    "wasm": "inherits_llvm_compiler_pending_no_independent_admission",
    "forge": "unsupported_must_reject",
}


def load_contract():
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema_version") != "1.0.0":
        raise ValueError("unknown Option-pattern contract schema")
    if data.get("suite") != "oreslang.option-if-matches.v1":
        raise ValueError("unknown Option-pattern suite")
    if data.get("status_contract") != STATUS:
        raise ValueError("unsupported backend status contract mismatch")
    cases = data.get("cases")
    if not isinstance(cases, list) or len(cases) != len(ORACLES):
        raise ValueError("Option-pattern case inventory is missing or duplicated")
    seen = set()
    for case in cases:
        if not isinstance(case, dict) or not set(case).issubset(
                {"id", "reference", "runtime_exit", "source"}):
            raise ValueError("unknown Option-pattern case fields")
        identifier = case.get("id")
        if identifier in seen or ORACLES.get(identifier) != case.get("reference"):
            raise ValueError("duplicate, unknown or altered Option-pattern oracle")
        seen.add(identifier)
        source = case.get("source")
        if not isinstance(source, str) or not source.endswith("\n") or len(source) > 8192:
            raise ValueError("invalid Option-pattern source fixture")
        if " matches Some(" not in source or "fi" not in source:
            raise ValueError("missing canonical Option-pattern syntax")
        if case["reference"] == "accept":
            expected = case.get("runtime_exit")
            if type(expected) is not int or not 0 <= expected <= 125:
                raise ValueError("positive case needs bounded reference exit code")
        elif "runtime_exit" in case:
            raise ValueError("rejected case cannot invent an execution result")
    if seen != set(ORACLES):
        raise ValueError("incomplete Option-pattern inventory")
    return cases


def invoke(template, path):
    argv = [arg.replace("{source}", str(path)) for arg in template]
    if not any("{source}" in arg for arg in template):
        raise ValueError("compiler invocation must use an explicit {source} placeholder")
    try:
        result = subprocess.run(argv, capture_output=True, timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("compiler invocation unavailable (not a rejection)") from exc
    if len(result.stdout) > 2_000_000 or len(result.stderr) > 2_000_000:
        raise RuntimeError("compiler output exceeds bounded evidence size")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, choices=tuple(STATUS))
    parser.add_argument("--report", type=Path)
    parser.add_argument("--revision", default="unverified")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.revision != "unverified" and not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        raise ValueError("revision must be the exact 40-character commit SHA")
    cases = load_contract()
    template = args.command[1:] if args.command[:1] == ["--"] else args.command
    if args.backend == "wasm":
        if template:
            raise ValueError("Wasm depends on the pinned LLVM compiler; do not fake independent admission")
        print("OPTION_PATTERN|backend=wasm|inventory=9|status=PENDING_NO_COMPILER_EXECUTION")
        return 0
    if not template:
        raise ValueError("executable compiler command required; source-only verification is not parity")

    report = {"suite": "oreslang.option-if-matches.v1", "backend": args.backend,
              "revision": args.revision, "status": "failed", "cases": []}
    with tempfile.TemporaryDirectory(prefix="ores-option-pattern-") as temp:
        directory = Path(temp)
        if args.backend != "graal":
            # A broken/missing compiler that rejects EVERY file must fail the
            # control. This separates unsupported-feature rejection from a
            # non-running toolchain or invalid invocation.
            control = directory / "control.ores"
            control.write_text("pub fnc main(): int { return 42; }\n", encoding="utf-8")
            checked = invoke(template, control)
            if checked.returncode != 0:
                raise RuntimeError("native backend did not accept the basic scalar control")

        for case in cases:
            file = directory / (case["id"].replace(".", "-") + ".ores")
            encoded = case["source"].encode("utf-8")
            file.write_bytes(encoded)
            result = invoke(template, file)
            if args.backend == "graal":
                ok = result.returncode == (0 if case["reference"] == "accept" else 1)
            else:
                output = result.stdout.decode("utf-8", errors="replace")
                emitted_ir = re.search(r"(?m)^(?:\\s*; ModuleID|\\s*target triple|\\s*define (?:internal )?i\\d+)", output)
                ok = result.returncode != 0 and not emitted_ir
            report["cases"].append({
                "id": case["id"], "source_sha256": hashlib.sha256(encoded).hexdigest(),
                "expected_reference": case["reference"], "compiler_exit": result.returncode,
                "verified": bool(ok),
            })
    if all(case["verified"] for case in report["cases"]):
        report["status"] = ("reference_admission_verified" if args.backend == "graal"
                            else "unsupported_syntax_rejected_not_parity")
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("OPTION_PATTERN|backend=%s|cases=%d|status=%s" %
          (args.backend, len(report["cases"]), report["status"]))
    return 0 if report["status"] != "failed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print("OPTION_PATTERN|status=FAIL_CLOSED|reason=%s" % exc, file=sys.stderr)
        sys.exit(2)
