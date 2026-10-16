#!/usr/bin/env python3
"""Mutation tests for the shared actor-pipeline verification gate."""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile


def run(verifier: pathlib.Path, data: dict):
    with tempfile.TemporaryDirectory(prefix="ores-v1-contract-") as temp:
        fixture = pathlib.Path(temp) / "routing.json"
        fixture.write_text(json.dumps(data, ensure_ascii=True), encoding="utf-8")
        return subprocess.run([sys.executable, str(verifier), str(fixture)],
                              text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=10)


def main():
    root = pathlib.Path(__file__).resolve().parent
    verifier = root / "verify_actor_pipeline_v1.py"
    original = json.loads((root / "actor-pipeline-routing-v1.json").read_text())
    if run(verifier, original).returncode != 0:
        raise AssertionError("canonical routing fixture fails the baseline validator")
    samples = []
    def mutation(name, apply):
        altered = copy.deepcopy(original)
        apply(altered)
        samples.append((name, altered))

    mutation("missing NUL golden vector", lambda d: d["operations"]["by_key"].pop())
    mutation("forged key destination", lambda d: d["operations"]["by_key"][0].update(target="worker-b"))
    mutation("forged FNV hash", lambda d: d["operations"]["by_key"][1].update(fnv1a64_hex="0"*16))
    mutation("oversized routing key", lambda d: d["operations"]["by_key"][0].update(key="x"*4097))
    mutation("invalid Unicode key", lambda d: d["operations"]["by_key"][3].update(key="\ud800"))
    mutation("altered RR sequence", lambda d: d["operations"]["forward_round_robin"].reverse())
    mutation("unknown supposedly connected target", lambda d: d["operations"]["forward_to"].update(target="other"))
    mutation("invalid target suddenly connected", lambda d: d["operations"]["invalid_target"].update(target="worker-a"))
    mutation("silent default forward", lambda d: d["operations"]["forward"].update(error="choose first"))
    mutation("duplicate worker instance", lambda d: d["graph"]["stages"][2].update(id="worker-a"))
    mutation("NUL actor instance", lambda d: d["graph"]["stages"][1].update(id="worker\0x"))
    mutation("overlong UTF-8 instance", lambda d: d["graph"]["stages"][1].update(id="🌍"*65))
    mutation("invalid supervisor actor role", lambda d: d["graph"]["stages"][1].update(role="supervisor"))
    def add_cycle(d):
        for index in (1, 2):
            d["graph"]["stages"][index].update(role="transform", outbound="Event")
        d["graph"]["connections"].extend([
            {"source": "worker-a", "target": "worker-b", "payload": "Event"},
            {"source": "worker-b", "target": "worker-a", "payload": "Event"}])
    mutation("genuine transform cycle", add_cycle)
    mutation("nominal payload mismatch", lambda d: d["graph"]["connections"][0].update(payload="Wrong"))
    mutation("duplicate endpoint pair", lambda d: d["graph"]["connections"].append(copy.deepcopy(d["graph"]["connections"][0])))
    mutation("unknown destination", lambda d: d["graph"]["connections"][0].update(target="unknown"))
    mutation("self edge", lambda d: d["graph"]["connections"][0].update(target="producer-1"))
    mutation("isolated extra actor", lambda d: d["graph"]["stages"].append(dict(id="orphan",actor_type="T",role="readable",inbound="",outbound="Event")))
    mutation("vertex quota exceeded", lambda d: d["graph"]["stages"].extend(copy.deepcopy(d["graph"]["stages"][0]) for _ in range(1022)))
    mutation("edge quota exceeded", lambda d: d["graph"]["connections"].extend(copy.deepcopy(d["graph"]["connections"][0]) for _ in range(4094)))
    failures = []
    for name, case in samples:
        result = run(verifier, case)
        if result.returncode == 0:
            failures.append(name)
    if failures:
        print("Unsafe fixtures ACCEPTED:", failures, file=sys.stderr)
        raise SystemExit(1)
    print(f"ORES_ACTOR_PIPELINE_CONTRACT_MUTATION_PASS rejected={len(samples)}")


if __name__ == "__main__":
    main()
