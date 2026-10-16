#!/usr/bin/env python3
"""Fail-closed source fixture gate for Oreslang bootstrap backends.

admission is compiler acceptance ONLY; stdout-i64 also executes the guest.
Do not interpret admission as compiled guest/runtime parity.
"""
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
MAX_OUTPUT_BYTES = 65536
MAX_FIXTURE_BYTES = 1048576


def read_bounded_regular_fixture(source):
    """Read a fixture through its opened file descriptor, never a FIFO.

    POSIX no-follow/nonblocking flags prevent symlink and FIFO substitutions
    from turning a manifest check into an unbounded read or a hang. Windows
    uses regular-file lstat/fstat checks; these are not an atomic trust boundary.
    """
    original = source.lstat()
    if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1:
        raise ValueError("source fixture must be a unique regular file")
    if not 0 < original.st_size <= MAX_FIXTURE_BYTES:
        raise ValueError("invalid source length")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(source, flags)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise ValueError("fixture replaced by nonregular file")
        if not same_fixture_identity(original, opened):
            raise ValueError("fixture changed before read")
        data = stream.read(MAX_FIXTURE_BYTES + 1)
        after = os.fstat(stream.fileno())
        if not same_fixture_identity(opened, after):
            raise ValueError("fixture changed during read")
    final = source.lstat()
    if not same_fixture_identity(after, final):
        raise ValueError("fixture path changed during read")
    if not 0 < len(data) <= MAX_FIXTURE_BYTES:
        raise ValueError("invalid source length")
    return data


def same_fixture_identity(before, after):
    return all(getattr(before, attr) == getattr(after, attr) for attr in (
        "st_dev", "st_ino", "st_mode", "st_size", "st_nlink",
        "st_mtime_ns", "st_ctime_ns"
    ))


def load_suite():
    suite_bytes = (HERE / "cases.json").read_bytes()
    suite = json.loads(suite_bytes)
    if not isinstance(suite, dict) or set(suite) != {"schema_version", "cases"} or suite["schema_version"] != "1.0.0":
        raise ValueError("unsupported manifest fields or version")
    if not isinstance(suite["cases"], list) or not (1 <= len(suite["cases"]) <= 100):
        raise ValueError("invalid case inventory")
    digest = hashlib.sha256(suite_bytes)
    seen, declared = set(), set()
    fixture_root = HERE / "fixtures"
    if fixture_root.is_symlink() or not fixture_root.is_dir():
        raise ValueError("fixture directory must be an ordinary directory")
    for case in suite["cases"]:
        if not isinstance(case, dict) or set(case) not in ({"id", "file", "kind", "value"}, {"id", "file", "kind"}):
            raise ValueError("unexpected case fields")
        cid, filename, kind = case["id"], case["file"], case["kind"]
        if not isinstance(cid, str) or not re.fullmatch(r"[a-z][a-z0-9.-]{1,79}", cid) or cid in seen:
            raise ValueError("invalid or duplicate case id")
        seen.add(cid)
        if not isinstance(filename, str) or not re.fullmatch(r"fixtures/[a-z0-9-]+\.ores", filename):
            raise ValueError("invalid fixture filename")
        if filename in declared:
            raise ValueError("duplicate source fixture: " + filename)
        source = HERE / filename
        if source.is_symlink() or source.resolve().parent != fixture_root.resolve():
            raise ValueError("fixture path escapes fixture root")
        data = read_bounded_regular_fixture(source)
        if b"\x00" in data:
            raise ValueError("embedded NUL in source fixture")
        data.decode("utf-8", errors="strict")
        digest.update(filename.encode("ascii") + b"\x00" + data)
        declared.add(filename)
        if kind == "accept":
            value = case.get("value")
            if not isinstance(value, str) or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value):
                raise ValueError("positive case requires canonical decimal value")
            if not (-(1 << 63) <= int(value) < (1 << 63)):
                raise ValueError("expected i64 outside range")
        elif kind != "reject" or "value" in case:
            raise ValueError("negative case may not specify a value")
    disk = {"fixtures/" + p.name for p in fixture_root.iterdir()}
    if disk != declared:
        raise ValueError("orphan/missing fixture: " + str(sorted(disk ^ declared)))
    return suite, digest.hexdigest()


def run_case(command, source, kind, value, mode, timeout):
    argv = [s.replace("{source}", str(source)) for s in command]
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                  timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, "infrastructure: " + type(exc).__name__
        if out.tell() > MAX_OUTPUT_BYTES or err.tell() > MAX_OUTPUT_BYTES:
            return False, "compiler output exceeded 64 KiB"
        out.seek(0)
        err.seek(0)
        stdout = out.read().decode("utf-8", "replace")
        stderr = err.read().decode("utf-8", "replace")
    if kind == "reject":
        success = proc.returncode == 1 and not stdout and bool(stderr.strip())
    elif mode == "stdout-i64":
        success = proc.returncode == 0 and stdout.strip() == value and not stderr.strip()
    else:
        success = proc.returncode == 0 and not stderr.strip()
    return success, ("exit=" + str(proc.returncode) + " stderr=" + repr(stderr[:160])
                     + " stdout=" + repr(stdout[:160]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=("java", "llvm", "net", "forge", "wasm"), required=True)
    ap.add_argument("--mode", choices=("admission", "stdout-i64"), required=True)
    ap.add_argument("--command", required=True, help="argv template with exactly one {source}")
    ap.add_argument("--revision", help="exact tested Git commit SHA")
    ap.add_argument("--report", type=Path)
    ap.add_argument("--timeout", type=int, default=20)
    opts = ap.parse_args()
    if opts.revision and not re.fullmatch(r"[0-9a-f]{40}", opts.revision):
        ap.error("--revision must be a full lowercase Git commit SHA")
    if opts.report and not opts.revision:
        ap.error("--report requires --revision; unpinned execution evidence is not publishable")
    if not (1 <= opts.timeout <= 300):
        ap.error("--timeout must be 1..300 seconds")
    cmd = shlex.split(opts.command)
    if not cmd or sum(part.count("{source}") for part in cmd) != 1:
        ap.error("--command must contain exactly one {source} placeholder")
    suite, digest = load_suite()
    records, failures = [], 0
    for case in suite["cases"]:
        ok, details = run_case(cmd, HERE / case["file"], case["kind"],
                               case.get("value"), opts.mode, opts.timeout)
        records.append({"id": case["id"], "status": "pass" if ok else "fail"})
        if not ok:
            failures += 1
        print(("PASS" if ok else "FAIL") + " " + case["id"] + ("" if ok else ": " + details), flush=True)
    if opts.report:
        opts.report.parent.mkdir(parents=True, exist_ok=True)
        opts.report.write_text(json.dumps({"schema_version": "1.0.0", "backend": opts.backend,
            "evidence_level": "source-executed-scalar" if opts.mode == "stdout-i64" else "compiler-admission-only",
            "source_revision": opts.revision, "suite_sha256": digest, "results": records}, indent=2) + "\n")
    print(f"SCALAR_PARITY {opts.backend} mode={opts.mode} cases={len(records)} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, UnicodeError, KeyError) as exc:
        print("SCALAR_PARITY_INFRASTRUCTURE_ERROR: " + str(exc), file=sys.stderr)
        sys.exit(2)
