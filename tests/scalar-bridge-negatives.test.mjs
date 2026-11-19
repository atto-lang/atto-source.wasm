import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,existsSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const bridge=resolve(new URL('../tools/atto_scalar_aot.mjs',import.meta.url).pathname);
const sha=path=>createHash('sha256').update(read(path)).digest('hex');
import {readFileSync} from 'node:fs';
function read(path){return readFileSync(path)}
function scenario(fn){
  const dir=mkdtempSync(join(tmpdir(),'atto-aot-negative-'));
  try{
    const source=join(dir,'program.atto'),tool=join(dir,'dummy-compiler'),out=join(dir,'output');
    writeFileSync(source,'pub fnc main(): int { return 7; }\n');
    writeFileSync(tool,"#!/bin/sh\nprintf 'untrusted fake compiler output'\n",{mode:0o755});
    const options={source,tool,out};
    function execute(extra=[],override={}){
      const s=override.source||source,t=override.tool||tool;
      const digest=sha(source),tdigest=sha(tool);
      const flags=[s,'--source-sha256',override.digest||digest,
        '--compiler',t,'--compiler-sha256',override.compiler_sha||tdigest,
        '--precompiler',tool,'--precompiler-sha256',tdigest,
        '--wasm-clang',tool,'--wasm-clang-sha256',tdigest,
        '--wasm-ld',tool,'--wasm-ld-sha256',tdigest,
        '--out',out,...extra];
      const result=spawnSync(process.execPath,[bridge,...flags],{encoding:'utf8',timeout:10000});
      assert.equal(result.status,2,result.stderr+'\n'+result.stdout);
      assert.match(result.stderr,/ATTO_SCALAR_AOT_NOT_EXECUTED/);
      return result.stderr;
    }
    fn({...options,execute});
  }finally{rmSync(dir,{recursive:true,force:true});}
}
function denied(name,expect,fn){test(name,()=>scenario(e=>{
  const out=fn(e),msg=e.execute(out.extra||[],out.override||{});
  assert.match(msg,expect);assert.ok(!existsSync(e.out),'no rejected artifacts');
}));}
denied('reject non-.atto input',/only actual .atto/,e=>{const alt=join(e.source,'../','fake.ll');writeFileSync(alt,read(e.source));return {override:{source:alt}}});
denied('reject wrong source SHA',/input SHA256/,()=>({override:{digest:'0'.repeat(64)}}));
denied('reject missing compiler',/missing or nonexecutable/,e=>({override:{tool:join(e.out,'missing')}}));
denied('reject compiler digest mismatch',/input SHA256/,()=>({override:{compiler_sha:'f'.repeat(64)}}));
denied('reject fake LLVM IR before Wasm/AOT',/LLVM compiler emitted no wasm32 main IR/,()=>({}));
denied('reject missing debug runner digest',/debug runner and digest/,e=>({extra:['--debug-runner',e.tool]}));
denied('reject expected scalar without runner',/expected observed scalar/,()=>({extra:['--expect-scalar','7']}));
denied('reject symlink source',/symlinked input/,e=>{const link=join(e.out+'-link.atto');symlinkSync(e.source,link);return {override:{source:link}}});
denied('reject nonexecutable compiler',/missing or nonexecutable/,e=>{chmodSync(e.tool,0o644);return {}});
test('reject pre-existing output without writing files',()=>scenario(e=>{
  mkdirSync(e.out);
  assert.match(e.execute(),/output directory already exists/);
  assert.deepEqual(readdirSync(e.out),[]);
}));
