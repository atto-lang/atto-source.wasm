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


def run_raw(verifier: pathlib.Path, contents: str):
    with tempfile.TemporaryDirectory(prefix="ores-v1-json-") as temp:
        fixture = pathlib.Path(temp) / "routing.json"
        fixture.write_text(contents, encoding="utf-8")
        return subprocess.run([sys.executable, str(verifier), str(fixture)],
                              text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=10)


def guard_file_shapes(verifier: pathlib.Path, original: dict):
    """Only a bounded, unique regular routing contract can be executed."""
    import os
    with tempfile.TemporaryDirectory(prefix="ores-v1-file-") as work:
        root = pathlib.Path(work)
        valid = root / "valid.json"
        valid.write_text(json.dumps(original, ensure_ascii=True), encoding="utf-8")
        if subprocess.run([sys.executable, str(verifier), str(valid)],
                          capture_output=True, timeout=4).returncode != 0:
            raise AssertionError("ordinary valid JSON file unexpectedly rejected")
        oversized = root / "oversized.json"
        with oversized.open("wb") as out:
            out.truncate(256 * 1024 + 1)
        empty = root / "empty.json"
        empty.touch()
        directory = root / "directory.json"
        directory.mkdir()
        invalid_utf8 = root / "invalid-utf8.json"
        invalid_utf8.write_bytes(b"\xff")
        checks = [("oversized regular file", oversized),
                  ("empty regular file", empty),
                  ("directory instead of file", directory),
                  ("invalid UTF-8 JSON", invalid_utf8)]
        alias = root / "linked.json"
        try:
            os.link(valid, alias)
        except OSError:
            pass
        else:
            checks.append(("hardlink to valid fixture", alias))
            checks.append(("valid file with extra hardlink", valid))
        # Use an independent target: hardlink aliasing of 'valid' must
        # not make a symlink test pass for the wrong reason.
        symlink_target = root / "symlink-target.json"
        symlink_target.write_bytes(valid.read_bytes())
        symbolic = root / "symlink.json"
        try:
            symbolic.symlink_to(symlink_target)
        except (OSError, NotImplementedError):
            pass
        else:
            checks.append(("symlink to valid fixture", symbolic))
        if hasattr(os, "mkfifo"):
            fifo = root / "pipe.json"
            try:
                os.mkfifo(fifo)
            except OSError:
                pass
            else:
                checks.append(("named pipe must not block", fifo))
        for name, path in checks:
            with subprocess.Popen([sys.executable, str(verifier), str(path)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
                try:
                    proc.communicate(timeout=4)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    raise AssertionError(name + " blocked instead of rejecting")
                if proc.returncode == 0:
                    raise AssertionError("unsafe actor contract file ACCEPTED: " + name)
    return len(checks)


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
    mutation("terminal transform with no outbound connection",
             lambda d: d["graph"]["stages"][1].update(
                 role="transform", outbound="Event"))
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
    # Raw JSON tests: regular dict/json.dumps cannot represent duplicate
    # keys. Each of these parses successfully with json.loads defaults and
    # would otherwise be accepted as the canonical fixture.
    raw = json.dumps(original, ensure_ascii=True)
    malformed_json = [
        ("duplicate top-level schema key",
         '{"schema":"ignored",' + raw[1:]),
        ("duplicate nested target key",
         raw.replace('"target": "worker-a"',
                     '"target":"worker-z","target": "worker-a"', 1)),
        ("nonfinite extension",
         '{"untrusted_extension":NaN,' + raw[1:]),
        ("overflowing exponent extension",
         '{"untrusted_extension":1e999,' + raw[1:]),
        ("negative overflowing exponent extension",
         '{"untrusted_extension":-1e999,' + raw[1:]),
    ]
    failures = []
    for name, contents in malformed_json:
        if run_raw(verifier, contents).returncode == 0:
            failures.append(name)
    for name, case in samples:
        result = run(verifier, case)
        if result.returncode == 0:
            failures.append(name)
    if failures:
        print("Unsafe fixtures ACCEPTED:", failures, file=sys.stderr)
        raise SystemExit(1)
    file_guards = guard_file_shapes(verifier, original)
    print(f"ORES_ACTOR_PIPELINE_CONTRACT_MUTATION_PASS rejected={len(samples) + len(malformed_json)} file_guards={file_guards}")


if __name__ == "__main__":
    main()
