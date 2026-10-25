#!/usr/bin/env python3
"""Minimal well-formed Wasm corpus for the AOT source admission boundary.
These are intentionally VALID modules: rejection must come from Oreslang
policy, not generic Wasm parser failure.
"""
from pathlib import Path
import sys

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
header = b'\0asm\1\0\0\0'

def section(kind, payload):
    assert len(payload) < 128
    return bytes((kind, len(payload))) + payload

sig = section(1, bytes((1, 0x60, 0, 1, 0x7e)))  # () -> i64
function = section(3, bytes((1, 0)))
memory = section(5, bytes((1, 1, 1, 2)))  # one bounded memory 1..2
exports = section(7, bytes((2, 4)) + b'main' +
                  bytes((0, 0, 6)) + b'memory' + bytes((2, 0)))
code = section(10, bytes((1, 4, 0, 0x42, 42, 0x0b)))

(root / 'valid.wasm').write_bytes(header + sig + function + memory + exports + code)
# Valid Wasm with empty element section: must be denied by scalar policy.
(root / 'element.wasm').write_bytes(
    header + sig + function + memory + exports +
    section(9, bytes((0,))) + code)
(root / 'table.wasm').write_bytes(
    header + sig + function + section(4, bytes((1, 0x70, 0, 1))) +
    memory + exports + code)
(root / 'extra-memory.wasm').write_bytes(
    header + sig + function +
    section(5, bytes((2, 1, 1, 2, 1, 1, 2))) + exports + code)

# Valid start function needs a second function of signature () -> ().
sig_with_start = section(1, bytes((2, 0x60, 0, 1, 0x7e, 0x60, 0, 0)))
functions_with_start = section(3, bytes((2, 0, 1)))
code_with_start = section(10, bytes((2, 4, 0, 0x42, 42, 0x0b, 2, 0, 0x0b)))
(root / 'start.wasm').write_bytes(
    header + sig_with_start + functions_with_start + memory + exports +
    section(8, bytes((1,))) + code_with_start)

# Valid imported env.f function at index 0, own main becomes index 1.
imports = section(2, bytes((1, 3)) + b'env' + bytes((1,)) +
                  b'f' + bytes((0, 0)))
shifted_exports = section(7, bytes((2, 4)) + b'main' +
                          bytes((0, 1, 6)) + b'memory' + bytes((2, 0)))
(root / 'import.wasm').write_bytes(
    header + sig + imports + function + memory + shifted_exports + code)
