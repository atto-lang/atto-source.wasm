#!/usr/bin/env python3
"""Fail-closed, source-local exact-byte v2 contract parity check.

The reference Git blob ID was independently read from pinned Java, LLVM,
.NET and Forge main trees on 2026-11-11. This checks shared contract bytes,
NOT successful language compilation or actual GPU execution.
"""
import hashlib
import json
from pathlib import Path
import sys

CONTRACT = Path(__file__).with_name("cpu-gpu-task-unsupported-v2.json")
CANONICAL_GIT_BLOB = "067d557ac02b85a9f1ea44811bf106a1529926de"
EXPECTED_CASES = frozenset({
    "cpu-sync-value", "gpu-sync-value", "task-default-future",
    "cpu-task-future", "gpu-task-future", "legacy-nb-default",
    "legacy-nb-cpu", "legacy-nb-gpu", "gpu-cpu-gpu-nested",
    "empty-gpu-task-reject",
})


class ContractError(ValueError):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("duplicate v2 contract case key")
        result[key] = value
    return result


def verify(data):
    if not isinstance(data, bytes) or not data or len(data) > 64 * 1024:
        raise ContractError("contract input is missing or oversized")
    digest = hashlib.sha1(
        b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    ).hexdigest()
    if digest != CANONICAL_GIT_BLOB:
        raise ContractError("CPU/GPU v2 contract Git blob diverges from four backends")
    try:
        contract = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError) as error:
        raise ContractError("invalid UTF-8 v2 contract JSON") from error
    if not isinstance(contract, dict) or set(contract) != EXPECTED_CASES:
        raise ContractError("CPU/GPU v2 contract case IDs diverged")
    if any(not isinstance(source, str) or not source.strip()
           for source in contract.values()):
        raise ContractError("CPU/GPU v2 contract source case invalid")
    return len(contract), digest


def self_test(reference):
    cases = (
        reference.replace(b"gpu-cpu-gpu-nested", b"gpu-cpu-gpu-v2-nested"),
        reference.replace(b"return await f;", b"return f;"),
        reference + b" ",
        b'{"cpu-sync-value":"x","cpu-sync-value":"y"}',
        b"",
    )
    for mutant in cases:
        try:
            verify(mutant)
        except ContractError:
            pass
        else:
            raise ContractError("unsafe v2 contract mutation was accepted")


def main(argv):
    if argv not in ([], ["--self-test"]):
        print("usage: check_cpu_gpu_task_v2_contract.py [--self-test]", file=sys.stderr)
        return 2
    try:
        source = CONTRACT.read_bytes()
        size, digest = verify(source)
        if argv:
            self_test(source)
    except (OSError, ContractError) as error:
        print("CPU_GPU_TASK_V2_CONTRACT_FAILED: " + str(error), file=sys.stderr)
        return 1
    print("CPU_GPU_TASK_V2_CANONICAL=PASS cases=%d git_blob=%s" % (size, digest))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
