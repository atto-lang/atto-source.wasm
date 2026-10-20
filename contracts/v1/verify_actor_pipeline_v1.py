#!/usr/bin/env python3
"""Shared Oreslang actor DAG and routing vectors; host contract only."""
import json
import math
import os
import pathlib
import stat
import sys

# Contract JSON is a cross-backend trust boundary. Python's default decoder
# silently keeps the final duplicate key and also accepts NaN/Infinity. Other
# JSON implementations may reject or interpret those bytes differently.
MAX_CONTRACT_BYTES = 256 * 1024


def read_bounded_contract(source: pathlib.Path) -> bytes:
    """Reject symlink/FIFO/device/hardlink substitution before bounded reads."""
    def identity(a, b):
        return all(getattr(a, name) == getattr(b, name) for name in (
            "st_dev", "st_ino", "st_mode", "st_size", "st_nlink",
            "st_mtime_ns", "st_ctime_ns"
        ))

    before = source.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise ValueError("actor routing contract must be a unique regular file")
    if not 0 < before.st_size <= MAX_CONTRACT_BYTES:
        raise ValueError("actor routing contract exceeds 256 KiB budget")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(source, flags)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or not identity(before, opened):
            raise ValueError("actor routing contract changed before read")
        raw = stream.read(MAX_CONTRACT_BYTES + 1)
        after = os.fstat(stream.fileno())
        if not identity(opened, after):
            raise ValueError("actor routing contract changed during read")
    if not identity(after, source.lstat()):
        raise ValueError("actor routing contract path changed during read")
    if not 0 < len(raw) <= MAX_CONTRACT_BYTES:
        raise ValueError("actor routing contract exceeds 256 KiB budget")
    return raw


def load_contract(source: pathlib.Path) -> dict:
    raw = read_bounded_contract(source)

    def unique_members(items):
        decoded = {}
        for key, value in items:
            if key in decoded:
                raise ValueError(f"duplicate actor routing JSON member: {key}")
            decoded[key] = value
        return decoded

    def reject_nonfinite(value):
        raise ValueError(f"non-finite actor routing JSON number: {value}")

    def finite_float(value):
        # json.loads allows a syntactically valid exponent such as 1e999
        # to overflow Python float into infinity. parse_constant is never
        # called for that spelling, so reject overflow during decoding.
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("non-finite actor routing JSON float")
        return number

    result = json.loads(raw.decode("utf-8", errors="strict"),
                        object_pairs_hook=unique_members,
                        parse_constant=reject_nonfinite,
                        parse_float=finite_float)
    if not isinstance(result, dict):
        raise ValueError("actor routing JSON root must be an object")
    return result

def main() -> int:
    source = pathlib.Path(sys.argv[1])
    data = load_contract(source)
    # This fixed v1 policy corpus is an authority boundary, not an
    # extensible user-defined description of routing capabilities. Deny
    # unrecognized fields and forged guest-lowering/control claims.
    def exact_fields(obj, expected, location):
        if type(obj) is not dict or set(obj) != set(expected):
            raise AssertionError("unexpected routing v1 fields at " + location)

    exact_fields(data, ("schema", "scope", "graph", "operations",
                        "rejected", "notes"), "root")
    exact_fields(data["graph"], ("stages", "connections"), "graph")
    exact_fields(data["operations"],
                 ("forward", "forward_all", "forward_round_robin",
                  "forward_to", "invalid_target", "by_key"), "operations")
    exact_fields(data["operations"]["forward"], ("error",), "forward")
    exact_fields(data["operations"]["forward_to"],
                 ("target", "expected"), "forward_to")
    exact_fields(data["operations"]["invalid_target"],
                 ("target", "error"), "invalid_target")
    for stage in data["graph"]["stages"]:
        exact_fields(stage, ("id", "actor_type", "role",
                             "inbound", "outbound"), "stage")
    for edge in data["graph"]["connections"]:
        exact_fields(edge, ("source", "target", "payload"), "edge")
    for record in data["operations"]["by_key"]:
        exact_fields(record, ("key", "fnv1a64_hex", "target"), "by_key")

    if data["scope"] != "host-selector-only; source actor lowering is a separate release gate":
        raise AssertionError("guest actor routing authority is not admitted")
    if data["rejected"] != [
            "duplicate-instance-id", "duplicate-edge", "unknown-target",
            "self-edge", "payload-mismatch", "cyclic-graph", "invalid-utf8",
            "overlong-component", "post-retirement-route"]:
        raise AssertionError("routing v1 denial policy changed")
    if data["notes"] != [
            "sender identity authenticated by runtime before real mailbox admission",
            "fan-out is nontransactional",
            "receipt only indicates admission",
            "RR attempt consumes turn even when mailbox rejects",
            "no shared mutable actor heap alias",
            "no borrowed actor state crossing suspension"]:
        raise AssertionError("routing v1 actor authority policy changed")
    if data["operations"]["invalid_target"]["error"] != "not connected":
        raise AssertionError("disconnected target error policy changed")
    if data["schema"] != "oreslang.actor-pipeline-routing.v1":
        raise AssertionError("wrong routing fixture schema")
    if data["operations"]["forward_all"] != ["worker-a", "worker-b", "worker-c"]:
        raise AssertionError("canonical three-worker fan-out order")
    if data["operations"]["forward_round_robin"] != [
            "worker-a", "worker-b", "worker-c",
            "worker-a", "worker-b", "worker-c"]:
        raise AssertionError("canonical six-step RR vector")
    keys = data["operations"]["by_key"]
    if [entry["key"] for entry in keys] != [
            "customer-7", "alpha", "beta", "🌍", "", "\0"]:
        raise AssertionError("missing/reordered six canonical routing keys")
    for entry in keys:
        h = 0xcbf29ce484222325
        key_bytes = entry["key"].encode("utf-8", "strict")
        if len(key_bytes) > 4096:
            raise AssertionError("routing key byte budget exceeded")
        for byte in key_bytes:
            h = ((h ^ byte) * 0x100000001b3) & 0xffffffffffffffff
        if f"{h:016x}" != entry["fnv1a64_hex"]:
            raise AssertionError(f"hash mismatch for {entry['key']!r}")
        index = h % 3
        if data["operations"]["forward_all"][index] != entry["target"]:
            raise AssertionError(f"route mismatch for {entry['key']!r}")
    stages = data["graph"]["stages"]
    edges = data["graph"]["connections"]
    if not 2 <= len(stages) <= 1024 or not 1 <= len(edges) <= 4096:
        raise AssertionError("graph size budget violated")
    def text_bytes(value, allow_empty=False):
        if not isinstance(value, str) or (not value and not allow_empty):
            raise AssertionError("empty actor graph component")
        if "\0" in value:
            raise AssertionError("NUL actor graph component")
        encoded = value.encode("utf-8", "strict")
        if len(encoded) > 256:
            raise AssertionError("actor graph UTF-8 byte limit")
        return encoded
    ids = {}
    for stage in stages:
        for item in ("id", "actor_type"):
            text_bytes(stage[item])
        text_bytes(stage["inbound"], True)
        text_bytes(stage["outbound"], True)
        role, inbound, outbound = stage["role"], stage["inbound"], stage["outbound"]
        if (stage["id"] in ids or not (
                (role == "readable" and not inbound and outbound)
                or (role == "writable" and inbound and not outbound)
                or (role in ("transform", "duplex") and inbound and outbound))):
            raise AssertionError("invalid role or duplicate graph instance")
        ids[stage["id"]] = stage
    degrees = {name: 0 for name in ids}
    adjacency = {name: [] for name in ids}
    pair_ids = set()
    for edge in edges:
        for field in ("source", "target", "payload"):
            text_bytes(edge[field])
        a, b, t = edge["source"], edge["target"], edge["payload"]
        if (a not in ids or b not in ids or a == b or (a, b) in pair_ids
                or ids[a]["outbound"] != t or ids[b]["inbound"] != t
                or ids[a]["role"] == "writable" or ids[b]["role"] == "readable"):
            raise AssertionError("invalid graph edge or duplicate endpoint pair")
        pair_ids.add((a, b))
        degrees[b] += 1
        adjacency[a].append(b)
    # Port declarations alone are insufficient: a transform must have
    # at least one ACTUAL inbound and outbound edge. This is the same
    # fail-closed graph-admission rule used by the Java/LLVM selectors.
    for instance, stage in ids.items():
        inbound = degrees[instance]
        outbound = len(adjacency[instance])
        role = stage["role"]
        if ((inbound == 0 and outbound == 0)
                or (role == "readable" and outbound == 0)
                or (role == "writable" and inbound == 0)
                or (role == "transform" and (inbound == 0 or outbound == 0))):
            raise AssertionError("pipeline actor missing connected role port")
    roots = [a for a, count in degrees.items() if count == 0]
    if not any(ids[r]["role"] in ("readable", "duplex") for r in roots):
        raise AssertionError("no authorized ingress root")
    visited = 0
    ready = roots[:]
    pos = 0
    while pos < len(ready):
        a = ready[pos]
        pos += 1
        visited += 1
        for b in adjacency[a]:
            degrees[b] -= 1
            if degrees[b] == 0:
                ready.append(b)
    if visited != len(stages):
        raise AssertionError("cyclic actor graph")
    if any(not (adjacency[a] or any(a in targets for targets in adjacency.values()))
           for a in ids):
        raise AssertionError("isolated graph actor")
    if adjacency.get("producer-1") != data["operations"]["forward_all"]:
        raise AssertionError("fan-out order does not match published graph")
    if (len(adjacency["producer-1"]) == 1
            or data["operations"]["forward"]["error"] != "ambiguous forward"):
        raise AssertionError("ambiguous one-to-many forward not rejected")
    target = data["operations"]["forward_to"]
    if target["target"] not in adjacency["producer-1"] or target["expected"] != target["target"]:
        raise AssertionError("explicit target route is not connected")
    if data["operations"]["invalid_target"]["target"] in adjacency["producer-1"]:
        raise AssertionError("invalid target unexpectedly connected")
    for i, target in enumerate(data["operations"]["forward_round_robin"]):
        if target != adjacency["producer-1"][i % len(adjacency["producer-1"])]:
            raise AssertionError("published RR not deterministic")
    for key in ("", "\ud800", "🌍" * 1025):
        if key == "":
            continue
        try:
            encoded = key.encode("utf-8", "strict")
            if len(encoded) <= 4096:
                raise AssertionError("invalid/overlong routing key accepted")
        except UnicodeError:
            pass
    if len("🌍".encode("utf-8")) != 4:
        raise AssertionError("UTF-8 scalar width drift")
    print("ORES_ACTOR_PIPELINE_V1_CONTRACT_PASS")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
