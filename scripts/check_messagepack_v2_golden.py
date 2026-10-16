#!/usr/bin/env python3
"""Source-free MessagePack v2 golden oracle, NOT a guest/runtime conformance claim."""
import copy
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

SCHEMAS = {
    "demo.TupleBoolString.v1", "demo.FixedArrayInts.v1",
    "demo.FixedListNested.v1", "demo.ArrayStrings.v1",
    "demo.ListStrings.v1", "demo.String.v1",
}

def require(ok, reason):
    if not ok:
        raise ValueError(reason)

def parse_shape(text):
    def parse(i):
        require(i < len(text), "truncated shape")
        for kind in ("FA", "FL", "T", "A", "L"):
            if text.startswith(kind + "[", i):
                i += len(kind) + 1
                children = []
                while True:
                    require(i < len(text), "unterminated shape")
                    if text[i] == "]":
                        return (kind, children), i + 1
                    child, i = parse(i)
                    children.append(child)
                    require(i < len(text), "unterminated shape")
                    if text[i] == ",":
                        i += 1
                    elif text[i] != "]":
                        raise ValueError("bad shape separator")
                # Unreachable: the closing bracket returns above.
        require(text[i] in "BIFS", "unknown scalar shape")
        return (text[i], []), i + 1
    tree, at = parse(0)
    require(at == len(text), "trailing shape tokens")
    def check(node):
        k, children = node
        if k in ("A", "L"):
            require(len(children) == 1, "variable sequence arity")
        for child in children:
            check(child)
    check(tree)
    return tree

def pack_array(n):
    require(0 <= n <= 100_000, "array length budget")
    if n <= 15:
        return bytes([0x90 | n])
    if n <= 65535:
        return b"\xdc" + struct.pack(">H", n)
    return b"\xdd" + struct.pack(">I", n)

def pack_string(text):
    require(type(text) is str, "expected string")
    data = text.encode("utf-8", errors="strict")
    n = len(data)
    require(n <= 1_048_576, "string byte budget")
    if n <= 31:
        return bytes([0xa0 | n]) + data
    if n <= 255:
        return b"\xd9" + bytes([n]) + data
    if n <= 65535:
        return b"\xda" + struct.pack(">H", n) + data
    return b"\xdb" + struct.pack(">I", n) + data

def pack_integer(n):
    require(type(n) is int and -(1 << 63) <= n < (1 << 63), "signed i64 only")
    if -32 <= n <= 127: return bytes([n & 255])
    if 0 <= n <= 255: return b"\xcc" + struct.pack(">B", n)
    if 0 <= n <= 65535: return b"\xcd" + struct.pack(">H", n)
    if 0 <= n <= 0xffffffff: return b"\xce" + struct.pack(">I", n)
    if n >= 0: return b"\xcf" + struct.pack(">Q", n)
    if n >= -128: return b"\xd0" + struct.pack(">b", n)
    if n >= -32768: return b"\xd1" + struct.pack(">h", n)
    if n >= -2147483648: return b"\xd2" + struct.pack(">i", n)
    return b"\xd3" + struct.pack(">q", n)

def pack_value(tree, value, nodes, depth=0):
    nodes[0] += 1
    require(depth <= 64 and nodes[0] <= 100_000, "value depth/node budget")
    kind, children = tree
    if kind == "B":
        require(type(value) is bool, "expected bool")
        return b"\xc3" if value else b"\xc2"
    if kind == "I": return pack_integer(value)
    if kind == "F":
        require(type(value) is float and math.isfinite(value), "finite f64 only")
        return b"\xcb" + struct.pack(">d", value)
    if kind == "S": return pack_string(value)
    require(type(value) is list, "expected sequence")
    if kind in ("A", "L"):
        require(len(children) == 1, "variable sequence element arity")
    else:
        require(len(value) == len(children), "fixed sequence arity")
    out = bytearray(pack_array(len(value)))
    for i, item in enumerate(value):
        child = children[0 if kind in ("A", "L") else i]
        out.extend(pack_value(child, item, nodes, depth + 1))
        require(len(out) <= 1_048_576, "wire byte budget")
    return bytes(out)

def canonical(vector):
    schema = vector["schema_id"]
    require(type(schema) is str and 0 < len(schema) <= 256
            and all(33 <= ord(ch) <= 126 for ch in schema), "schema ID")
    shape = vector["shape_descriptor"]
    require(type(shape) is str and len(shape) <= 1_048_576, "shape")
    tree = parse_shape(shape)
    digest = hashlib.sha256(("oreslang.actor.shape.v2/" + shape).encode("ascii")).digest()
    data = (pack_array(4) + pack_integer(2) + pack_string(schema)
            + b"\xc4\x20" + digest + pack_value(tree, vector["input"], [0]))
    require(len(data) <= 1_048_576, "envelope byte budget")
    return data

def verify(document):
    require(document.get("schema") == "oreslang.messagepack.collections.v2", "corpus ID")
    vectors = document.get("vectors")
    require(type(vectors) is list and len(vectors) == 6, "six vectors required")
    require({v["schema_id"] for v in vectors} == SCHEMAS, "missing or duplicate schemas")
    for v in vectors:
        try:
            given = bytes.fromhex(v["hex"])
        except (TypeError, ValueError) as exc:
            raise ValueError("bad hex") from exc
        require(given == canonical(v), "golden bytes mismatch independent oracle")
    return True

def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parents[1] / "contracts/v1/messagepack_collection_vectors.json")
    document = json.loads(path.read_text(encoding="utf-8"))
    verify(document)
    rejected = 0
    for index in range(6):
        for field in ("schema_id", "shape_descriptor", "input", "hex"):
            tampered = copy.deepcopy(document)
            item = tampered["vectors"][index]
            if field == "schema_id": item[field] += ".forged"
            elif field == "shape_descriptor": item[field] = "B" if item[field] == "S" else "S"
            elif field == "input": item[field] = None
            else: item[field] = "00" + item[field][2:]
            try:
                verify(tampered)
            except (ValueError, TypeError, KeyError, UnicodeError):
                rejected += 1
            else:
                raise AssertionError("mutated golden fixture accepted: " + field)
    assert rejected == 24, rejected
    print("PASS 6 canonical MessagePack v2 vectors and 24 negative fixture mutations (source-free oracle)")

if __name__ == "__main__":
    main()
