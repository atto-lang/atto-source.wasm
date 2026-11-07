#!/usr/bin/env python3
"""Development-only .atto scalar source -> LLVM IR -> wasm32 -> Wasmtime AOT.

Does not implement actor/tenant-VM ABI: the current scalar Wasmtime profile
prohibits all imports. A real AttoLang LLVM compiler is REQUIRED. No fallback
to C, mock IR or already compiled .wasm is allowed for the primary path.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HEX64 = re.compile(r"[0-9a-f]{64}\Z")
MAX_SOURCE = 1024 * 1024
MAX_IR = 4 * 1024 * 1024
MAX_WASM = 16 * 1024 * 1024


class NotExecuted(ValueError):
    pass


def read_pinned(path, claimed, limit):
    p = Path(path)
    if not p.is_file() or p.is_symlink():
        raise NotExecuted("missing, nonregular or symlinked input " + str(p))
    size = p.stat().st_size
    if size == 0 or size > limit:
        raise NotExecuted("input byte budget rejected: " + str(p))
    data = p.read_bytes()
    if not HEX64.fullmatch(claimed) or hashlib.sha256(data).hexdigest() != claimed:
        raise NotExecuted("input SHA256 does not match the pinned bytes: " + str(p))
    return data


def executable(path, claimed):
    p = Path(path)
    if not p.is_file() or p.is_symlink() or not os.access(p, os.X_OK):
        raise NotExecuted("missing or nonexecutable tool: " + str(p))
    read_pinned(p, claimed, 150 * 1024 * 1024)
    return str(p.resolve())


def execute(argv, *, max_output=MAX_IR, seconds=120):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=seconds, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise NotExecuted("tool could not execute or timed out: " + argv[0]) from e
    if result.returncode or len(result.stdout) > max_output or len(result.stderr) > 32768:
        raise NotExecuted("tool rejected input, failed, or exceeded output limit: " + argv[0])
    return result.stdout, result.stderr


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source", help="actual local .atto source; no IR/wasm substitutes")
    p.add_argument("--source-sha256", required=True)
    p.add_argument("--compiler", required=True)
    p.add_argument("--compiler-sha256", required=True)
    p.add_argument("--wasm-clang", required=True)
    p.add_argument("--wasm-ld", required=True)
    p.add_argument("--precompiler", required=True)
    p.add_argument("--precompiler-sha256", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--debug-runner", help="explicitly insecure debug-only native AOT runner")
    p.add_argument("--debug-runner-sha256")
    p.add_argument("--expect-scalar", type=int, help="only when --debug-runner is provided")
    args = p.parse_args(argv)
    try:
        source = Path(args.source)
        if source.suffix != ".atto":
            raise NotExecuted("only actual .atto source is accepted")
        raw_source = read_pinned(source, args.source_sha256, MAX_SOURCE)
        llvmc = executable(args.compiler, args.compiler_sha256)
        builder = executable(args.precompiler, args.precompiler_sha256)
        if bool(args.debug_runner) != bool(args.debug_runner_sha256):
            raise NotExecuted("debug runner and digest must be provided together")
        if (args.expect_scalar is not None) != bool(args.debug_runner):
            raise NotExecuted("expected observed scalar is required only with debug runner")
        runner = executable(args.debug_runner, args.debug_runner_sha256) if args.debug_runner else None
        clang = executable(args.wasm_clang, hashlib.sha256(Path(args.wasm_clang).read_bytes()).hexdigest())
        ld = executable(args.wasm_ld, hashlib.sha256(Path(args.wasm_ld).read_bytes()).hexdigest())
        final = Path(args.out)
        if final.exists() or final.is_symlink():
            raise NotExecuted("output directory already exists; refusal to overwrite artifacts")
        # All compilation runs before publishing any artifact to the requested directory.
        with tempfile.TemporaryDirectory(prefix="atto-wasm-aot-") as temp:
            work = Path(temp)
            ir, diagnostics = execute([llvmc, "--target=wasm32", str(source.resolve())])
            if not ir or b"wasm32" not in ir or b"define" not in ir or b"@main" not in ir:
                raise NotExecuted("LLVM compiler emitted no wasm32 main IR; unsupported guest ABI")
            (work / "source.ll").write_bytes(ir)
            execute([clang, "--target=wasm32-unknown-unknown", "-Oz", "-nostdlib",
                     "-mno-bulk-memory", "-mno-reference-types", "-mno-simd128",
                     "-x", "ir", "-c", str(work / "source.ll"), "-o", str(work / "source.o")])
            execute([ld, "--no-entry", "--export=main", "--export-memory",
                     "--initial-memory=131072", "--max-memory=131072", "--gc-sections",
                     str(work / "source.o"), "-o", str(work / "source.wasm")])
            wasm = (work / "source.wasm").read_bytes()
            if not wasm.startswith(b"\x00asm") or not (8 <= len(wasm) <= MAX_WASM):
                raise NotExecuted("wasm32 linker did not produce bounded core Wasm")
            wasm_sha = hashlib.sha256(wasm).hexdigest()
            output, diagnostics = execute([builder, str(work / "source.wasm"), wasm_sha,
                                           str(work / "source.cwasm")], max_output=4096)
            aot = (work / "source.cwasm")
            if not aot.is_file():
                raise NotExecuted("precompiler produced no native AOT module")
            aot_sha = hashlib.sha256(aot.read_bytes()).hexdigest()
            if ("aot_sha256="+aot_sha) not in output.decode("ascii"):
                raise NotExecuted("precompiler provenance output did not match produced AOT")
            observed = None
            if runner:
                output, stderr = execute([runner, str(aot), aot_sha], max_output=128)
                if stderr or output != (str(args.expect_scalar)+"\n").encode("ascii"):
                    raise NotExecuted("real native guest scalar output mismatch")
                observed = args.expect_scalar
            manifest = {
                "schema": "atto.scalar-compiler-to-wasmtime-aot.v1",
                "execution_profile": "LOCAL_DEVELOPMENT_NOT_PRODUCTION",
                "source_file": source.name,
                "source_sha256": hashlib.sha256(raw_source).hexdigest(),
                "llvm_compiler_sha256": args.compiler_sha256,
                "llvm_ir_sha256": hashlib.sha256(ir).hexdigest(),
                "wasm_sha256": wasm_sha,
                "aot_sha256": aot_sha,
                "guest_executed": runner is not None,
                "observed_scalar": observed,
                "safety": "no actor-tenant ABI; import-free scalar Wasm only; caller hash is not deployment authorization",
            }
            final.mkdir(parents=True, exist_ok=False)
            (final / "source.wasm").write_bytes(wasm)
            (final / "source.cwasm").write_bytes(aot.read_bytes())
            (final / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
        print("ATTO_SCALAR_AOT_BRIDGE=EXECUTED" if runner else "ATTO_SCALAR_AOT_BRIDGE=PRECOMPILED_ONLY")
        print("ATTO_SCALAR_AOT_SHA256="+aot_sha)
        print("EVIDENCE_SCOPE=ACTUAL_COMPILER_REQUIRED_SCALAR_ABI_NOT_ACTOR_TENANT_SECURITY")
        return 0
    except (NotExecuted, OSError, UnicodeError, ValueError) as error:
        print("ATTO_SCALAR_AOT_NOT_EXECUTED: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
