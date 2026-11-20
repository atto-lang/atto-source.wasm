#!/usr/bin/env node
// Real Rust-attoc source -> wasm32 inline task execution gate.
// This is NOT a source interpreter, scheduler, TaskScope or await implementation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,statSync,existsSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {fixed_memory_pages} from '../src/wasm-profile.mjs';

const [compilerPath, expectedSha] = process.argv.slice(2);
if (process.argv.length !== 4 || !isAbsolute(compilerPath ?? '') ||
    !/^[a-f0-9]{64}$/.test(expectedSha ?? ''))
  throw Error('Usage: node scripts/verify-sync-task-wasm.mjs /absolute/reviewed/attoc <compiler_sha256_64hex>');
const sha256 = b => createHash('sha256').update(b).digest('hex');
const gitBlob = b => createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const compiler = realpathSync(compilerPath);
assert.ok(statSync(compiler).isFile(), 'attoc must be a regular file');
assert.equal(sha256(readFileSync(compiler)), expectedSha, 'reviewed compiler SHA-256 mismatch');
const src = readFileSync(fileURLToPath(new URL('../tests/fixtures/sync-task-inline-v1/main.atto', import.meta.url)));
assert.equal(gitBlob(src), 'e08cbf7ccc5b0d041897ce215c2c3a1f434f983f',
  'unreviewed canonical inline sync task fixture');
const work = mkdtempSync(join(tmpdir(),'atto-sync-task-wasm32-'));
const receipts = [];
function compile_case(id, source) {
  const input = join(work, id + '.atto');
  const output = join(work, id + '.wasm');
  writeFileSync(input, source, {flag:'wx'});
  const result=spawnSync(compiler,[input,'-o',output],{
    encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
    env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}
  });
  assert.equal(result.error,undefined,id+' compiler did not start');
  assert.equal(result.signal,null,id+' compiler crashed/timed out');
  return {result,output};
}
function execute(id, source) {
  const {result,output}=compile_case(id,source);
  assert.equal(result.status,0,id+' compile failed: '+result.stderr);
  const size=statSync(output).size;
  assert.ok(size>8&&size<=1024*1024,id+' invalid guest size');
  const bytes=readFileSync(output);
  assert.ok(WebAssembly.validate(bytes),id+' invalid emitted guest');
  const pages=fixed_memory_pages(bytes); // 0 is valid for scalar-only guests.
  // If the compiler emits linear memory, the Wasm profile ensures it is fixed and bounded.
  // Any present memory must be explicitly exported, never hidden from the host.
  assert.ok(pages>=0,id+' invalid memory layout');
  const module=new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module),[],id+' imports unsupported host authority');
  const exports=WebAssembly.Module.exports(module);
  const memoryExports=exports.filter(e=>e.kind==='memory');
  assert.equal(memoryExports.length,pages===0?0:1,id+' memory export must match fixed memory layout');
  assert.ok(exports.some(e=>e.name==='main'&&e.kind==='function'),id+' main must be a function');
  assert.ok(exports.some(e=>e.name==='panic_code'&&e.kind==='global'),id+' panic code must be a global');
  const names=WebAssembly.Module.exports(module).map(e=>e.name);
  assert.ok(names.includes('main')&&names.includes('panic_code'),id+' ABI missing');
  assert.ok(names.every(x=>['main','panic_code','memory'].includes(x)),id+' unexpected authority');
  const guest=new WebAssembly.Instance(module,{});
  assert.equal(guest.exports.main(),42n,id+' result must be 42');
  assert.equal(guest.exports.panic_code.value,0,id+' panicked');
  receipts.push({id,kind:'guest-executed',wasm_sha256:sha256(bytes)});
}
function reject(id, body, code) {
  const source = 'pub fnc main(): int { ' + body + ' }\n';
  const {result,output}=compile_case(id,source);
  assert.equal(result.status,1,id+' must reject source before codegen');
  assert.ok(result.stderr.includes(code),id+' wrong typed diagnostic: '+result.stderr);
  assert.equal(existsSync(output),false,id+' emitted artifact after rejection');
  receipts.push({id,kind:'compile-reject-no-artifact',diagnostic:code});
}
try {
  execute('canonical-inline',src);
  execute('void-inline-return','pub fnc main(): int { do sync task { return; }; return 42; }\n');
  execute('void-lifo-defer','pub fnc main(): int { let x = 0; do sync task<void> { defer { x = 1; }; defer { x = 2; }; return; }; return 41 + x; }\n');
  execute('scalar-branch-return','pub fnc main(): int { val x = sync task<int> { if true { return 40; } else { return 7; } fi }; return x + 2; }\n');
  execute('nested-block-return','pub fnc main(): int { val x = sync task<int> { block { val y = 42; return y; } }; return x; }\n');

  // Must mirror the exact native Rust/Wasm compiler's #438 typed rejection policy.
  reject('bare-sync-statement','sync task {}; return 42;','E_SYNTAX');
  reject('typed-void-without-do','sync task<void> {}; return 42;','E_SYNTAX');
  reject('do-sync-int','do sync task<int> { return 42; }; return 0;','E_TASK_RETURN_TYPE');
  reject('do-sync-value','do sync task { return 42; }; return 0;','E_TASK_RETURN_TYPE');
  reject('void-as-value','val x = sync task<void> {}; return 42;','E_TYPE');
  reject('unscheduled-task','val x = task<int> { return 42; }; return 0;','E_UNSUPPORTED');
  reject('unimplemented-await','val x = sync task<int> { return await task<int> { return 42; }; }; return x;','E_UNSUPPORTED');
  reject('void-typed-nonvoid-return','do sync task<void> { return 7; }; return 42;','E_TASK_RETURN_TYPE');
  reject('nonvoid-mismatched-type','val x = sync task<int> { return true; }; return 0;','E_TYPE');
  reject('missing-typed-return','val x = sync task<int> { if true { return 42; } fi }; return x;','E_RETURN');
  reject('no-body-discard-int','do sync task<int> {}; return 42;','E_TASK_RETURN_TYPE');

  assert.equal(sha256(readFileSync(compiler)),expectedSha,'compiler changed during execution');
  console.log(JSON.stringify({
    status:'PASS',profile:'atto-inline-sync-task-v1',
    evidence_kind:'source-compiled-rust-attoc-real-wasm32-guest',
    compiler_sha256:expectedSha,
    source_git_blob:'e08cbf7ccc5b0d041897ce215c2c3a1f434f983f',
    cases:receipts
  }));
}finally{
  rmSync(work,{recursive:true,force:true});
}
