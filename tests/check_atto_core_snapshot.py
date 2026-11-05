#!/usr/bin/env python3
"""Fail-closed source-only AttoLang canonical core identity gate.

This checks vendored guest SOURCE; it does NOT execute a compiler or guest.
"""
from pathlib import Path
import hashlib
import sys

SNAPSHOT = "contracts/atto-core-v1"
MODULES = {
    "numeric.atto": "5ced991f1d49b3c2a60fdd72b9003c0a4d18cd72",
    "core.atto": "d2cd9b8e0cd3e3bb3ee6a5f9cebf9ab3312c44f4",
}
MAX_BYTES = 1024 * 1024

class Rejected(ValueError):
    pass


def git_blob_hash(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\x00" + data).hexdigest()


def check(root: Path) -> dict[str, str]:
    root = Path(root)
    base = root / SNAPSHOT
    if root.is_symlink() or base.is_symlink() or not base.is_dir():
        raise Rejected("invalid snapshot directory")
    entries = set()
    for child in base.iterdir():
        if child.is_symlink() or not child.is_file():
            raise Rejected("symlink or unexpected file kind")
        entries.add(child.name)
    if entries != set(MODULES):
        raise Rejected("unexpected, missing or legacy duplicate module")
    verified = {}
    for name, expected in MODULES.items():
        path = base / name
        with path.open("rb") as handle:
            data = handle.read(MAX_BYTES + 1)
        if not data or len(data) > MAX_BYTES:
            raise Rejected("missing or oversized guest module")
        try:
            decoded = data.decode("utf-8", "strict")
        except UnicodeError as exc:
            raise Rejected("non-UTF8 guest source") from exc
        if decoded.startswith("\ufeff") or "\x00" in decoded:
            raise Rejected("BOM or NUL in guest source")
        digest = git_blob_hash(data)
        if digest != expected:
            raise Rejected("canonical .atto Git blob changed")
        verified[name] = digest
    return verified


def main() -> int:
    try:
        verified = check(Path(__file__).resolve().parents[1])
    except Rejected as exc:
        print("ATTO_CORE_SOURCE_REJECTED=" + str(exc), file=sys.stderr)
        return 1
    for name, digest in sorted(verified.items()):
        print(f"ATTO_CORE_SOURCE_ONLY|{name}|git_blob={digest}|compiler=NOT_EXECUTED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
