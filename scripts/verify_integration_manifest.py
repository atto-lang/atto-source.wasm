#!/usr/bin/env python3
"""Fail-closed verification of Oreslang's declaration-only integration manifests.

This is intentionally not an implementation or runtime parity test.
Uses only Python's standard library and does not contact GitHub or the network.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PROTOCOL = 'oreslang-ecosystem-integration'
NOTE = 'Declared integration touchpoints only; no CI or runtime parity is asserted.'
UPSTREAMS = {
    'oreslang-source.java': ('oreslang-common-source', 'oreslang-target-profiles'),
    'oreslang-source.llvm': ('oreslang-common-source', 'oreslang-target-profiles'),
    'oreslang-source.wasm': ('oreslang-source.llvm', 'oreslang-target-profiles', 'oreslang-wasm'),
    'oreslang-source.js': ('oreslang-common-source', 'oreslang-target-profiles'),
    'oreslang-source.hdl': ('oreslang-common-source', 'oreslang-target-profiles'),
    'oreslang-source.forge': ('oreslang-common-source', 'oreslang-target-profiles'),
    'oreslang-source.net': ('oreslang-common-source', 'oreslang-target-profiles'),
}
EXPECTED_KEYS = frozenset({'schemaVersion', 'protocol', 'repository', 'role', 'upstreams', 'evidence', 'note'})
MAX_BYTES = 4096


class InvalidManifest(ValueError):
    pass


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    obj: dict[str, object] = {}
    for key, value in pairs:
        if key in obj:
            raise InvalidManifest(f'duplicate JSON key: {key!r}')
        obj[key] = value
    return obj


def _reject_constant(value: str) -> None:
    raise InvalidManifest(f'non-JSON constant: {value}')


def verify_bytes(raw: bytes, repository_name: str) -> dict[str, object]:
    """Return the verified manifest or raise InvalidManifest (no false attestations)."""
    if repository_name not in UPSTREAMS:
        raise InvalidManifest('unknown source repository')
    if not (1 <= len(raw) <= MAX_BYTES):
        raise InvalidManifest('manifest is empty or oversized')
    try:
        decoded = raw.decode('utf-8', errors='strict')
    except UnicodeError as exc:
        raise InvalidManifest('manifest must be valid UTF-8') from exc
    if decoded.startswith('\ufeff'):
        raise InvalidManifest('UTF-8 BOM is prohibited')
    try:
        value = json.loads(decoded, object_pairs_hook=_unique_pairs, parse_constant=_reject_constant)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise InvalidManifest('invalid JSON') from exc
    if not isinstance(value, dict) or set(value) != EXPECTED_KEYS:
        raise InvalidManifest('manifest must contain exactly the seven declared keys')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise InvalidManifest('unsupported schema version')
    if value['protocol'] != PROTOCOL or type(value['protocol']) is not str:
        raise InvalidManifest('unsupported protocol')
    if type(value['repository']) is not str or value['repository'] != 'ores-truffle-oreslang/' + repository_name:
        raise InvalidManifest('repository identity mismatch')
    if type(value['role']) is not str or value['role'] != 'compiler':
        raise InvalidManifest('unexpected integration role')
    upstreams = value['upstreams']
    if type(upstreams) is not list or any(type(item) is not str for item in upstreams):
        raise InvalidManifest('upstreams must be a string array')
    if tuple(upstreams) != UPSTREAMS[repository_name]:
        raise InvalidManifest('unexpected, reordered, or duplicate upstream dependencies')
    if type(value['evidence']) is not str or value['evidence'] != 'not-attested':
        raise InvalidManifest('unverified parity/CI attestation is forbidden')
    if type(value['note']) is not str or value['note'] != NOTE:
        raise InvalidManifest('evidence disclaimer was changed')
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository-root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    root = args.repository_root.resolve()
    expected_name = root.name
    manifest = root / '.oreslang' / 'integration.json'
    try:
        if manifest.is_symlink() or not manifest.is_file():
            raise InvalidManifest('manifest missing or symlinked')
        if manifest.stat().st_size > MAX_BYTES:
            raise InvalidManifest('manifest exceeds size limit')
        verify_bytes(manifest.read_bytes(), expected_name)
    except (InvalidManifest, OSError) as exc:
        print(f'integration manifest DENIED: {exc}', file=sys.stderr)
        return 1
    print(f'integration declaration verified: {expected_name}; evidence remains not-attested')
    return 0


if __name__ == '__main__':
    sys.exit(main())
