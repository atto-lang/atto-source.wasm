#!/usr/bin/env python3
"""Shared Oreslang actor DAG and routing vectors; host contract only."""
import json
import pathlib
import sys

def main() -> int:
    source = pathlib.Path(sys.argv[1])
    data = json.loads(source.read_text(encoding="utf-8"))
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
