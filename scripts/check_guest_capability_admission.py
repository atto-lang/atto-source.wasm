#!/usr/bin/env python3
"""Exercise real bootstrap compiler frontends against shared Oreslang sources.

No generated guest runs and no source copies leave this repository. This is
compile-time admission only: reject != proof of runtime OS sandboxing.
Java and WASM intentionally have no adapter and MUST NOT be marked green.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contracts/guest-capability-admission.v1.json"
COMMANDS = {
    "llvm": lambda program, tool: [tool, str(program)],
    "forge": lambda program, tool: [tool, "ir", str(program)],
    "net": lambda program, tool: [tool, "run", "--project",
                  "compiler/Ores.Net.Compiler/Ores.Net.Compiler.csproj",
                  "-c", "Release", "--", "check", str(program)],
}
DEFAULTS = {"llvm": "build/oreslang-llvmc", "forge": "build/oresforge",
            "net": "dotnet"}
# Source-level diagnostic prefix from the REAL compiler. Build failures,
# CLI usage failures, and shell errors must never count as deny evidence.
REJECTION_PREFIXES = {
    "llvm": "oreslang-llvmc:", "forge": "oresforge:", "net": "oresnet:",
}
# Deliberately avoid inheriting Actions tokens, CI secrets, SSH agents,
# injected compilers, or private cloud credentials into tested subprocesses.
TOOLCHAIN_ENV_KEYS = frozenset({
    "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "DOTNET_ROOT", "DOTNET_CLI_HOME",
    "DOTNET_NOLOGO", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "NUGET_PACKAGES",
    "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
})


def sanitized_toolchain_environment():
    return {key: value for key, value in os.environ.items()
            if key.upper() in TOOLCHAIN_ENV_KEYS}


CASES = ("scalar_arithmetic_14", "ambient_filesystem", "ambient_network",
         "ambient_process", "ambient_host_interop", "unsupported_actor",
         "unsupported_async", "unsupported_channel",
         "unsupported_wire_serialization")
CATEGORIES = ("scalar", "filesystem", "network", "process", "ffi",
              "actors", "async", "channels", "serialization")
EXPECTED_CASE_KEYS = frozenset({"id", "category", "source", "bootstrap"})
SCALAR_CASE_KEYS = EXPECTED_CASE_KEYS | {"expected_output"}


CASE_SHA256 = (
    "061f49bda81fae44d8d96b04791a85bf3d115287b204a55812a60bae253ec784",
    "c767dda0c5276f4b1a0438ee5f121606bc168aa9a33fd9956ee5ce160f26d83f",
    "72a8cd8e83a0d3eaa7d4499b52083ac19194c3db24eb146e302c642e1d60eb68",
    "3027b667e5aa3720e3d01b4095c4d93c0adb066ad5397eec97955bf491aa8121",
    "329503b1dcf448f5f5c86e6443872fecf6db2b2017445b0c2bd05749c4688e96",
    "fd95da702c0b0a2ea315b8975564ab34a5d73b085dfe056a0d048349bb69f8bc",
    "dd67bdd566f1ca06a9d16c494584a6ab37daf3be7eaa0cb7ecc14872974d9056",
    "9a172a9cea204792f3fdf1edcbc747f1c1356fb47756780910815d66559116a8",
    "2320bc4bc38d33cc824225f3848255d0f8ce722ebf2026365bbf693cbc5d6e6b",
)



def load_cases():
    doc = json.loads(CONTRACT.read_text(encoding="utf-8"))
    if (doc.get("schema_version") != 1 or
            doc.get("contract") != "oreslang-guest-admission-bootstrap-v1" or
            doc.get("proof_scope") != "source-compiler-acceptance-or-rejection-only" or
            doc.get("runnable_backends") != ["llvm", "net", "forge"] or
            doc.get("unimplemented_adapters") != ["java", "wasm"]):
        raise ValueError("unknown or weakened guest admission contract")
    items = doc.get("cases")
    if (not isinstance(items, list) or len(items) != len(CASES)
            or not all(isinstance(item, dict) for item in items)
            or tuple(item["id"] for item in items) != CASES):
        raise ValueError("incomplete guest admission case list")
    for index, item in enumerate(items):
        if (item.get("category") != CATEGORIES[index]
                or set(item) != (SCALAR_CASE_KEYS if index == 0 else EXPECTED_CASE_KEYS)):
            raise ValueError("guest capability category or case schema changed")
    for item, expected_digest in zip(items, CASE_SHA256):
        if not isinstance(item.get("source"), str) or (
                hashlib.sha256(item["source"].encode("utf-8")).hexdigest()
                != expected_digest):
            raise ValueError("guest fixture bytes differ from reviewed source")
    for item in items:
        if (item.get("bootstrap") not in ("accept", "reject")
                or not isinstance(item.get("source"), str)
                or not item["source"].strip()
                or item.get("category") is None):
            raise ValueError("malformed guest source or expected admission")
    if items[0].get("expected_output") != "14" or any(
            item.get("bootstrap") != "reject" for item in items[1:]):
        raise ValueError("bootstrap test expectations changed")
    return items


def check(backend, tool=None, timeout=60):
    cases = load_cases()
    if backend not in COMMANDS:
        raise ValueError("no executable source-compiler adapter: " + backend)
    tool = tool or DEFAULTS[backend]
    if not isinstance(tool, str) or not tool.strip():
        raise ValueError("compiler path must be supplied")
    results = []
    with tempfile.TemporaryDirectory(prefix="ores-admission-") as directory:
        for item in cases:
            source = Path(directory) / (item["id"] + ".ores")
            source.write_text(item["source"], encoding="utf-8")
            argv = COMMANDS[backend](source, tool)
            # Compiler *only*: LLVM IR output, Forge IR output, .NET 'check'.
            # Never run arbitrary guest programs to test unsupported syntax.
            try:
                done = subprocess.run(argv, cwd=ROOT, text=True, capture_output=True,
                                      timeout=timeout, check=False,
                                      env=sanitized_toolchain_environment())
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise RuntimeError(item["id"] + ": compiler unavailable or timed out") from exc
            # Parser rejection is not the same as process termination or
            # infrastructure failure. Never accept segfaults, signals, or
            # unknown exit statuses as evidence of safe compiler admission.
            if done.returncode not in (0, 1):
                raise RuntimeError(item["id"] +
                    ": compiler crashed or returned unknown status " +
                    str(done.returncode))
            accepted = done.returncode == 0
            if not accepted and not done.stderr.strip().startswith(
                    REJECTION_PREFIXES[backend]):
                raise RuntimeError(item["id"] +
                    ": non-compiler failure cannot prove capability rejection; " +
                    "status=" + str(done.returncode) +
                    " stderr=" + done.stderr[:400])
            if not accepted and backend in ("llvm", "forge") and done.stdout.strip():
                raise RuntimeError(item["id"] +
                    ": rejected source emitted partial compiler IR")
            expected_accept = item["bootstrap"] == "accept"
            if accepted != expected_accept:
                raise RuntimeError(item["id"] +
                    ": expected " + item["bootstrap"] +
                    ", compiler status " + str(done.returncode) +
                    "; stdout=" + done.stdout[:400] +
                    "; stderr=" + done.stderr[:400])
            if accepted and (not done.stdout.strip() or
                    (backend == "net" and "typed OresIR: OK" not in done.stdout)):
                raise RuntimeError(item["id"] + ": empty/ambiguous compiler output")
            results.append((item["id"], item["bootstrap"]))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["llvm","net","forge","java","wasm"],
                        required=True)
    parser.add_argument("--tool", default=None)
    args = parser.parse_args()
    try:
        for name, state in check(args.backend, args.tool):
            print("GUEST_ADMISSION_OK " + args.backend + " " + name + " " + state)
    except (ValueError, OSError, RuntimeError) as exc:
        print("GUEST_ADMISSION_NOT_VERIFIED: " + str(exc), file=sys.stderr)
        return 1
    print("GUEST_ADMISSION_CONTRACT_PASSED: compile-time subset ONLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
