#!/usr/bin/env python3
"""Independent stdlib-only v2 golden-vector verifier; NOT backend runtime proof."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct

ROOT = Path(__file__).resolve().parents[1]
VECTORS = ROOT / 'contracts/v1/design/messagepack_collection_vectors.json'
EXPECTED = {
    'demo.TupleBoolString.v1', 'demo.FixedArrayInts.v1',
    'demo.FixedListNested.v1', 'demo.ArrayStrings.v1',
    'demo.ListStrings.v1', 'demo.String.v1',
    'demo.I64Edges.v1', 'demo.Unicode.v1',
    'demo.F64SignedZero.v1', 'demo.EmptyTuple.v1',
}


def check(ok, reason):
    if not ok:
        raise ValueError(reason)


def unique_pairs(pairs):
    d = {}
    for k, v in pairs:
        check(k not in d, 'duplicate JSON field ' + k)
        d[k] = v
    return d


def canonical_shape(kind, shape, depth=0):
    check(depth <= 64, 'oversized shape depth')
    scalars = {'bool': 'B', 'int64': 'I', 'float64': 'F', 'string': 'S'}
    if kind in scalars:
        check(shape == kind, 'scalar shape mismatch')
        return scalars[kind]
    fixed = {'Tuple': 'T', 'FixedArray': 'FA', 'FixedList': 'FL'}
    if kind in fixed:
        check(type(shape) is list and len(shape) <= 100_000, 'fixed shape must be bounded list')
        return fixed[kind] + '[' + ','.join(infer_shape(s, depth + 1) for s in shape) + ']'
    check(kind in ('Array', 'List') and type(shape) is dict and set(shape) == {'element'}, 'invalid collection shape')
    return ('A' if kind == 'Array' else 'L') + '[' + infer_shape(shape['element'], depth + 1) + ']'


def infer_shape(shape, depth):
    if isinstance(shape, str):
        return canonical_shape(shape, shape, depth)
    if type(shape) is dict and set(shape) == {'List'}:
        return 'L[' + infer_shape(shape['List'], depth + 1) + ']'
    check(False, 'unsupported nested shape')


def pack_int(value):
    check(type(value) is int and -(1 << 63) <= value < (1 << 63), 'expected signed i64')
    if -32 <= value <= 127:
        return struct.pack('B', value & 255)
    if value >= 0:
        for width, marker, limit in ((1, 0xcc, 255), (2, 0xcd, 65535),
                                      (4, 0xce, (1 << 32) - 1), (8, 0xcf, (1 << 63) - 1)):
            if value <= limit:
                return bytes([marker]) + value.to_bytes(width, 'big')
    else:
        for width, marker, minval in ((1, 0xd0, -128), (2, 0xd1, -32768),
                                       (4, 0xd2, -(1 << 31)), (8, 0xd3, -(1 << 63))):
            if value >= minval:
                return bytes([marker]) + value.to_bytes(width, 'big', signed=True)
    raise ValueError('integer out of range')


def pack_string(s):
    check(type(s) is str, 'expected string')
    buf = s.encode('utf-8', errors='strict')
    n = len(buf)
    check(n <= 1_048_576, 'string size')
    if n <= 31:
        header = bytes([0xa0 | n])
    elif n <= 255:
        header = b'\xd9' + n.to_bytes(1, 'big')
    elif n <= 65535:
        header = b'\xda' + n.to_bytes(2, 'big')
    else:
        header = b'\xdb' + n.to_bytes(4, 'big')
    return header + buf


def pack_array(items):
    check(type(items) is list and len(items) <= 100_000, 'array size')
    n = len(items)
    if n <= 15:
        hdr = bytes([0x90 | n])
    elif n <= 65535:
        hdr = b'\xdc' + n.to_bytes(2, 'big')
    else:
        hdr = b'\xdd' + n.to_bytes(4, 'big')
    return hdr + b''.join(items)


def pack_payload(kind, shape, v, depth=0):
    check(depth <= 64, 'payload depth')
    if kind == 'bool':
        check(type(v) is bool, 'expected bool')
        return b'\xc3' if v else b'\xc2'
    if kind == 'int64':
        return pack_int(v)
    if kind == 'float64':
        check(type(v) is float and math.isfinite(v), 'expected finite double')
        return b'\xcb' + struct.pack('>d', v)
    if kind == 'string':
        return pack_string(v)
    check(type(v) is list and len(v) <= 100_000, 'expected bounded list')
    if kind in ('Tuple', 'FixedArray', 'FixedList'):
        check(type(shape) is list and len(v) == len(shape), 'fixed arity')
        return pack_array([pack_nested(s, item, depth + 1) for s, item in zip(shape, v)])
    check(kind in ('Array', 'List') and type(shape) is dict and set(shape) == {'element'}, 'array shape')
    return pack_array([pack_nested(shape['element'], item, depth + 1) for item in v])


def pack_nested(shape, v, depth):
    if type(shape) is str:
        return pack_payload(shape, shape, v, depth)
    check(type(shape) is dict and set(shape) == {'List'}, 'nested shape unsupported')
    return pack_payload('List', {'element': shape['List']}, v, depth)


def validate(path=VECTORS):
    # Limit untrusted fixture processing and reject path substitution.
    check(bool(getattr(os, 'O_NOFOLLOW', 0)) and bool(getattr(os, 'O_NONBLOCK', 0)), 'safe open unavailable')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0))
    try:
        info = os.fstat(fd)
        check(stat.S_ISREG(info.st_mode) and info.st_size <= 131072, 'not a bounded regular file')
        with os.fdopen(fd, 'rb') as file:
            fd = -1
            raw = file.read(131073)
            check(len(raw) <= 131072, 'oversized fixture')
    finally:
        if fd >= 0:
            os.close(fd)
    def float_check(s):
        v = float(s)
        check(math.isfinite(v), 'nonfinite json')
        return v
    def constant_check(s):
        raise ValueError('nonfinite json constant')
    obj = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=unique_pairs,
                     parse_float=float_check, parse_constant=constant_check)
    check(type(obj) is dict and obj.get('schema') == 'oreslang.messagepack.collections.v2', 'wrong manifest schema')
    check(obj.get('status') == 'Portable v2 golden-byte reference only; actual backend implementations require executed tests. Unsupported shapes remain fail-closed.', 'feature support overclaim')
    vectors = obj.get('vectors')
    check(type(vectors) is list and len(vectors) == 10, 'expected ten vectors')
    names = [v.get('schema_id') for v in vectors]
    check(set(names) == EXPECTED and len(names) == len(set(names)), 'missing/duplicate vector IDs')
    for vec in vectors:
        check(type(vec) is dict and set(vec) in ({'schema_id', 'kind', 'shape', 'input', 'hex', 'shape_descriptor'},
                      {'schema_id', 'kind', 'shape', 'input', 'hex', 'shape_descriptor', 'input_encoding'}), 'unexpected vector fields')
        schema_id = vec['schema_id']
        check(type(schema_id) is str and 0 < len(schema_id) <= 256 and all(33 <= ord(c) <= 126 for c in schema_id), 'invalid schema ID')
        descriptor = canonical_shape(vec['kind'], vec['shape'])
        check(descriptor == vec['shape_descriptor'], schema_id + ' shape descriptor mismatch')
        payload = vec['input']
        if vec.get('input_encoding') == 'signed_i64_decimal_strings':
            check(schema_id == 'demo.I64Edges.v1' and type(payload) is list and
                  all(type(x) is str and re.fullmatch(r'-?(0|[1-9][0-9]*)', x) for x in payload), 'bad i64 metadata')
            payload = [int(v) for v in payload]
        elif vec.get('input_encoding') == 'finite_f64_signed_zero_string':
            check(schema_id == 'demo.F64SignedZero.v1' and payload == '-0.0', 'bad signed-zero metadata')
            payload = -0.0
        else:
            check('input_encoding' not in vec, 'unrecognized input encoding')
        envelope = pack_array([pack_int(2), pack_string(schema_id),
                               b'\xc4\x20' + hashlib.sha256(('oreslang.actor.shape.v2/' + descriptor).encode('ascii')).digest(),
                               pack_payload(vec['kind'], vec['shape'], payload)])
        check(len(envelope) <= 1_048_576 and envelope.hex() == vec['hex'], 'golden byte mismatch: ' + schema_id)
    return len(vectors)


if __name__ == '__main__':
    print('PASS 10/10 independent stdlib MessagePack v2 reference bytes (NOT backend runtime parity)' if validate() == 10 else 'FAIL')
