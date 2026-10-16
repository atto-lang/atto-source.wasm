#!/usr/bin/env python3
"""Exact-source, rejection-only five-backend CPU/GPU/nb corpus gate.

Identical in Java, LLVM, .NET, WASM and Forge. Validates contract provenance,
not parser/runtime/kernel implementation or permission to mirror private code.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile

PINNED_BLOBS = {
    "CPU_GPU_NB_V1.md": "c05b88f7d68bb86cd5a9e1ef3a4e08a044dbac1a",
    "cpu-gpu-nb-unsupported-v1.json": "05e084144d5034557c824e2ad227ae5263bcac40",
}
CASE_NAMES = frozenset({
    "cpu-value", "gpu-value", "nb-cpu-future", "nb-gpu-future",
    "cpu-gpu-nested", "gpu-cpu-nested", "gpu-cpu-gpu-nested",
    "nb-mixed-nested", "empty-gpu-value", "empty-nb-gpu-value",
})
MAX_BYTES = 100_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_checked(path, expected):
    require(not path.is_symlink() and path.is_file(), f"{path}: not a regular file")
    require(path.stat().st_size <= MAX_BYTES, f"{path}: exceeds size limit")
    data = path.read_bytes()
    actual = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
    require(actual == expected, f"{path}: source Git blob does not match pinned five-backend contract")
    return data.decode("utf-8")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate case name: {key}")
        result[key] = value
    return result


def reject_nonfinite(value):
    raise ValueError(f"nonfinite JSON value {value}")


def check(root):
    contents = {name: read_checked(root / name, sha) for name, sha in PINNED_BLOBS.items()}
    cases = json.loads(contents["cpu-gpu-nb-unsupported-v1.json"],
                       object_pairs_hook=unique_object, parse_constant=reject_nonfinite)
    require(type(cases) is dict and set(cases) == CASE_NAMES,
            "CPU/GPU/nb corpus case names differ from the pinned 10-case registry")
    require(all(type(source) is str and source.strip() for source in cases.values()),
            "every CPU/GPU/nb case must contain nonempty source text")
    contract = contents["CPU_GPU_NB_V1.md"]
    require("NOT executable five-backend parity" in contract and
            "Future<T>" in contract and "not multi-item streaming" in contract,
            "CPU/GPU/nb document must remain a rejection-only, non-stream contract")
    return len(cases)


def self_test(root):
    def scenario(name, mutate=None, should_pass=False):
        with tempfile.TemporaryDirectory(prefix="ores-dop-parity-") as folder:
            target = Path(folder)
            for source in PINNED_BLOBS:
                (target / source).write_bytes((root / source).read_bytes())
            if mutate:
                mutate(target)
            try:
                check(target)
            except (ValueError, UnicodeError, OSError, json.JSONDecodeError):
                if should_pass:
                    raise AssertionError(f"{name}: valid input was rejected")
            else:
                if not should_pass:
                    raise AssertionError(f"{name}: tampering was admitted")
        return name

    names = []
    names.append(scenario("exact-pinned-contract", should_pass=True))
    names.append(scenario("source-case-modification", lambda p:
        (p / "cpu-gpu-nb-unsupported-v1.json").write_bytes(
            (p / "cpu-gpu-nb-unsupported-v1.json").read_bytes().replace(b"42", b"43", 1))))
    names.append(scenario("contract-modification", lambda p:
        (p / "CPU_GPU_NB_V1.md").write_bytes(
            (p / "CPU_GPU_NB_V1.md").read_bytes() + b"\nnot approved\n")))
    names.append(scenario("truncated-case-registry", lambda p:
        (p / "cpu-gpu-nb-unsupported-v1.json").write_text("{}", encoding="utf-8")))
    names.append(scenario("duplicate-json-keys", lambda p:
        (p / "cpu-gpu-nb-unsupported-v1.json").write_text('{"x":"a","x":"b"}', encoding="utf-8")))
    names.append(scenario("nonfinite-json", lambda p:
        (p / "cpu-gpu-nb-unsupported-v1.json").write_text('{"x":NaN}', encoding="utf-8")))
    names.append(scenario("invalid-utf8", lambda p:
        (p / "cpu-gpu-nb-unsupported-v1.json").write_bytes(b"\xff")))
    names.append(scenario("oversize-registry", lambda p:
        (p / "cpu-gpu-nb-unsupported-v1.json").write_bytes(b" " * (MAX_BYTES + 1))))
    def link(p):
        path = p / "cpu-gpu-nb-unsupported-v1.json"
        real = p / "shadow.json"
        path.rename(real)
        path.symlink_to(real)
    names.append(scenario("symlink-substitution", link))
    names.append(scenario("missing-contract", lambda p:
        (p / "CPU_GPU_NB_V1.md").unlink()))
    print(f"CPU/GPU/nb pinned corpus self-tests: {len(names)}/{len(names)} passed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test(args.root)
    count = check(args.root)
    print(f"CPU/GPU/nb pinned corpus: PASS ({count} rejection-only cases)")


if __name__ == "__main__":
    main()
