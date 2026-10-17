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

# The fixture is evidence, not a self-justifying input: changing both the
# asserted hex bytes and its semantic values must require independent review.
PINNED_VECTORS_GIT_BLOB = "9937eb2bcd11ad59d59f4a0e4ac83953e5e5a1e6"
MAX_FIXTURE_BYTES = 65_536

def parse_shape(text):
    visited = [0]
    def parse(i, depth=0):
        visited[0] += 1
        require(depth <= 64 and visited[0] <= 100_000, "shape depth/node budget")
        require(i < len(text), "truncated shape")
        for kind in ("FA", "FL", "T", "A", "L"):
            if text.startswith(kind + "[", i):
                i += len(kind) + 1
                children = []
                while True:
                    require(i < len(text), "unterminated shape")
                    if text[i] == "]":
                        return (kind, children), i + 1
                    child, i = parse(i, depth + 1)
                    children.append(child)
                    require(i < len(text), "unterminated shape")
                    if text[i] == ",":
                        i += 1
                        # Canonical Java/C++ descriptors never emit a trailing
                        # comma, even for fixed-size shapes.
                        require(i < len(text) and text[i] != "]",
                                "trailing shape separator")
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

SCALAR_SHAPES = {"bool": "B", "int64": "I", "float64": "F", "string": "S"}
SEQUENCE_SHAPES = {"Tuple": "T", "FixedArray": "FA", "FixedList": "FL",
                   "Array": "A", "List": "L"}

def declared_shape_descriptor(vector):
    # Metadata is part of the public cross-backend fixture contract.
    # A matching hex envelope must not launder a mislabelled kind or shape.
    def element(spec, depth=0):
        require(depth <= 64, "metadata nesting depth")
        if type(spec) is str:
            require(spec in SCALAR_SHAPES, "unknown scalar metadata")
            return SCALAR_SHAPES[spec]
        require(type(spec) is dict and len(spec) == 1,
                "invalid collection metadata")
        kind, member = next(iter(spec.items()))
        require(kind in SEQUENCE_SHAPES, "unknown nested collection kind")
        prefix = SEQUENCE_SHAPES[kind]
        if kind in ("Array", "List"):
            return prefix + "[" + element(member, depth + 1) + "]"
        require(type(member) is list and len(member) <= 100_000,
                "invalid fixed metadata members")
        return prefix + "[" + ",".join(element(x, depth + 1)
                                       for x in member) + "]"

    kind = vector["kind"]
    shape = vector["shape"]
    if kind in SCALAR_SHAPES:
        require(shape == kind, "scalar kind/shape mismatch")
        return SCALAR_SHAPES[kind]
    require(kind in SEQUENCE_SHAPES, "unknown fixture kind")
    prefix = SEQUENCE_SHAPES[kind]
    if kind in ("Array", "List"):
        require(type(shape) is dict and set(shape) == {"element"},
                "variable collection requires one element type")
        return prefix + "[" + element(shape["element"], 1) + "]"
    require(type(shape) is list and len(shape) <= 100_000,
            "fixed collection must list member types")
    return prefix + "[" + ",".join(element(x, 1) for x in shape) + "]"

def pack_array(n):
    require(0 <= n <= 100_000, "array length budget")
    if n <= 15:
        return bytes([0x90 | n])
    if n <= 65535:
        return b"\xdc" + struct.pack(">H", n)
    return b"\xdd" + struct.pack(">I", n)

def pack_string(text):
    require(type(text) is str, "expected string")
    # Bound UTF-8 bytes before allocating a potentially enormous encoded
    # buffer. Python str may contain lone surrogates; those are never wire data.
    require(len(text) <= 1_048_576, "string byte budget")
    n = 0
    for ch in text:
        codepoint = ord(ch)
        require(not 0xd800 <= codepoint <= 0xdfff, "invalid Unicode scalar")
        n += (1 if codepoint <= 0x7f else 2 if codepoint <= 0x7ff
              else 3 if codepoint <= 0xffff else 4)
        require(n <= 1_048_576, "string byte budget")
    data = text.encode("utf-8", errors="strict")
    require(len(data) == n, "UTF-8 length disagreement")
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
    require(declared_shape_descriptor(vector) == shape,
            "fixture kind/shape metadata disagrees with pinned wire descriptor")
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
        raw_hex = v["hex"]
        require(type(raw_hex) is str
                and len(raw_hex) % 2 == 0
                and all(c in "0123456789abcdef" for c in raw_hex),
                "noncanonical lowercase contiguous hex")
        try:
            given = bytes.fromhex(raw_hex)
        except (TypeError, ValueError) as exc:
            raise ValueError("bad hex") from exc
        require(given == canonical(v), "golden bytes mismatch independent oracle")
    return True

def load_canonical_json(text):
    # A repeated key can silently replace the schema, vector shape or bytes
    # under ordinary json.loads(), making security fixture reviews ambiguous.
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON fixture key")
            result[key] = value
        return result
    def reject_constant(value):
        raise ValueError("nonfinite JSON fixture constant: " + value)
    return json.loads(text, object_pairs_hook=unique_pairs,
                      parse_constant=reject_constant)

def load_pinned_fixture(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(),
            "golden fixture must be a regular file")
    # Limit the actual read, including if input grows after an initial stat.
    with path.open("rb") as fixture:
        raw = fixture.read(MAX_FIXTURE_BYTES + 1)
    require(len(raw) <= MAX_FIXTURE_BYTES, "oversized golden fixture")
    git_blob = b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw
    require(hashlib.sha1(git_blob).hexdigest() == PINNED_VECTORS_GIT_BLOB,
            "golden fixture bytes changed without reviewed pin update")
    return load_canonical_json(raw.decode("utf-8", errors="strict"))


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parents[1] / "contracts/v1/messagepack_collection_vectors.json")
    document = load_pinned_fixture(path)
    verify(document)
    rejected = 0
    for index in range(6):
        for field in ("kind", "shape", "schema_id", "shape_descriptor", "input", "hex"):
            tampered = copy.deepcopy(document)
            item = tampered["vectors"][index]
            if field == "kind": item[field] = "Tuple" if item[field] != "Tuple" else "List"
            elif field == "shape": item[field] = "bool" if item[field] != "bool" else "string"
            elif field == "schema_id": item[field] += ".forged"
            elif field == "shape_descriptor": item[field] = "B" if item[field] == "S" else "S"
            elif field == "input": item[field] = None
            else: item[field] = "00" + item[field][2:]
            try:
                verify(tampered)
            except (ValueError, TypeError, KeyError, UnicodeError):
                rejected += 1
            else:
                raise AssertionError("mutated golden fixture accepted: " + field)
    assert rejected == 36, rejected
    print("PASS 6 canonical MessagePack v2 vectors and 36 negative fixture mutations (source-free oracle)")

if __name__ == "__main__":
    main()
