/**
 * Explicit real .ores actor -> LLVM wasm32 IR -> private-instance core WASM.
 * Experimental trusted-only bridge for the pooled OresVM actor vertical slice.
 * Never reuse the scalar-only compile-ores admission path (which rejects actors).
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {readBoundedRegularFile} from './compile-ores.mjs';
import {assertWasm32IrTarget} from './wasm32-ir-target.mjs';
import {inspectWasmBytes} from './inspect-core-memory.mjs';
import {assertScalarActorAbi} from './actor-scalar-abi.mjs';

const MAX_SOURCE = 1024 * 1024;
const MAX_COMPILER = 256 * 1024 * 1024;
const MAX_IR = 2 * 1024 * 1024;
const MAX_WASM = 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exportsRequired = [
  'oreslang_wasm_actor_init',
  'oreslang_wasm_actor_on_message',
  'oreslang_wasm_actor_teardown'
];
function invoke(exe, args, input) {
  const proc = spawnSync(exe, args, {
    input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true, env: {PATH: process.env.PATH || ''}
  });
  if (proc.error || proc.status !== 0 || proc.signal)
    throw Error('actor compilation command failed: ' +
      String(proc.error?.message || proc.stderr || `exit ${proc.status}`).slice(0, 2048));
  if (!proc.stdout || Buffer.byteLength(proc.stdout, 'utf8') > MAX_IR)
    throw Error('actor compiler did not emit bounded LLVM IR');
  return proc.stdout;
}

export async function compileSourceActorToWasm({compiler, source, clang = process.env.CLANG || 'clang',
  expectedCompilerSha256} = {}) {
  if (!isAbsolute(compiler || '') || !isAbsolute(source || ''))
    throw TypeError('source actor bridge requires absolute compiler/source paths');
  if (expectedCompilerSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedCompilerSha256))
    throw TypeError('invalid compiler SHA-256 pin');
  const [sourceRead, compilerRead] = await Promise.all([
    readBoundedRegularFile(source, MAX_SOURCE, 'source exceeds 1MiB budget'),
    readBoundedRegularFile(compiler, MAX_COMPILER, 'compiler exceeds 256MiB budget')
  ]);
  const sourceBytes = sourceRead.bytes, compilerBytes = compilerRead.bytes;
  const compilerSha256 = sha(compilerBytes), sourceSha256 = sha(sourceBytes);
  if (expectedCompilerSha256 !== undefined && expectedCompilerSha256 !== compilerSha256)
    throw Error('compiler binary SHA-256 mismatch');

  const scratch = await mkdtemp(join(tmpdir(), 'ores-source-actor-wasm-'));
  const stagedSource = join(scratch, 'source.ores');
  const stagedCompiler = join(scratch, 'compiler-exact');
  const output = join(scratch, 'actor.wasm');
  try {
    // Trust requirement: caller must independently approve compiler binary;
    // SHA-256 is byte identity, not proof that source commit built this binary.
    await writeFile(stagedSource, sourceBytes, {mode: 0o400, flag: 'wx'});
    await writeFile(stagedCompiler, compilerBytes, {mode: 0o500, flag: 'wx'});
    const ir = invoke(stagedCompiler, ['--target=wasm32', stagedSource]);
    assertWasm32IrTarget(ir);
    for (const name of exportsRequired)
      if (!ir.includes('@' + name + '(')) throw Error('missing compiler-generated actor ABI ' + name);
    if (/@oreslang_source_actor_spawn|@ores_actor_i64_heap_field/.test(ir))
      throw Error('unlowered native actor ABI in WASM actor IR');
    if (sha((await readBoundedRegularFile(stagedCompiler, MAX_COMPILER)).bytes) !== compilerSha256 ||
        sha((await readBoundedRegularFile(stagedSource, MAX_SOURCE)).bytes) !== sourceSha256 ||
        sha((await readBoundedRegularFile(compiler, MAX_COMPILER)).bytes) !== compilerSha256 ||
        sha((await readBoundedRegularFile(source, MAX_SOURCE)).bytes) !== sourceSha256)
      throw Error('compiler or source mutated during actor compilation');

    // Do not export guest main: pooled worker accepts ONLY the actor lifecycle
    // exports and its private bounded memory. No host imports or table ABI.
    const linked = spawnSync(clang, ['--target=wasm32', '-x', 'ir', '-Oz', '-nostdlib',
      '-Wl,--no-entry', '-Wl,--export-memory',
      ...exportsRequired.map(name => '-Wl,--export=' + name),
      '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072',
      '-o', output, '-'], {
      input: ir, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    if (linked.error || linked.status !== 0 || linked.signal)
      throw Error('actor wasm32 link failed: ' + String(linked.error?.message || linked.stderr).slice(0, 2048));
    const wasm = (await readBoundedRegularFile(output, MAX_WASM, 'actor Wasm exceeds 1MiB budget')).bytes;
    const inspected = inspectWasmBytes(wasm, {maxModuleBytes: MAX_WASM, maxMemoryPages: 2});
    if (inspected.memoryCount !== 1 || !inspected.hasMemoryMaximum ||
        inspected.memoryInitial !== 2 || inspected.memoryMaximum !== 2)
      throw Error('actor private two-page memory contract violated');
    assertScalarActorAbi(inspected.bytes);
    const module = new WebAssembly.Module(inspected.bytes);
    if (WebAssembly.Module.imports(module).length !== 0) throw Error('WASM actor imported host capability');
    const actualExports = WebAssembly.Module.exports(module);
    if (actualExports.length !== 4 ||
        ![...exportsRequired.map(name => ({name, kind: 'function'})),
          {name: 'memory', kind: 'memory'}].every(e =>
          actualExports.some(a => a.name === e.name && a.kind === e.kind)))
      throw Error('WASM actor export ABI mismatch');
    return {
      wasm,
      provenance: Object.freeze({kind: 'real-source-pooled-actor-v0',
        sourceSha256, compilerSha256, llvmIrSha256: sha(Buffer.from(ir, 'utf8')),
        wasmSha256: sha(wasm), wasmBytes: wasm.length, guestImports: 0,
        actorAbi: 'pooled-actor-i64-v0'})
    };
  } finally {await rm(scratch, {recursive: true, force: true});}
}
