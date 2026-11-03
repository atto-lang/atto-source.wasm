import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';

const cases=[
  ['inferred struct',`pub fnc main():int{
  const first=infer struct{x:20};
  const later=infer struct{...first,y:22};
  return later.x+later.y;
}`,42],
  ['readonly record',`pub fnc main():int{
  const original=infer record{x:20,y:1};
  const new_row=infer record{...original,y:23};
  return new_row.x+new_row.y;
}`,43],
  ['override final type',`pub fnc main():int{
  const first=infer struct{x:true,y:42};
  const last=infer struct{...first,x:2};
  return last.x+last.y;
}`,44]
];

const rejectedCases=[
  ['duplicate explicit field',`pub fnc main():int{
    const row=infer record{x:1,x:2};
    return row.x;
  }`],
  ['scalar spread operand',`pub fnc main():int{
    const row=infer struct{...42,y:2};
    return row.y;
  }`],
  ['missing spread binding',`pub fnc main():int{
    const row=infer record{...missing,y:2};
    return row.y;
  }`]
];

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const clang=process.env.CLANG || 'clang';
const mandatory=process.env.ATTO_WASM_AGGREGATE_REAL_GUEST==='1';

test('opt-in cannot bypass compiler pin even for a valid source snapshot',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'atto-wasm-pin-'));
  try{
    const fake=join(directory,'compiler');
    const source=join(directory,'source.atto');
    const output=join(directory,'output.wasm');
    await writeFile(fake,'not executable',{mode:0o700});
    await writeFile(source,cases[0][1]);
    await assert.rejects(
      compileOresToWasm({compiler:fake,source,output,
        experimentalStackAggregate:true,publication:'atomic'}),
      /requires exact compiler SHA-256 pin/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('exact LLVM compiler produces real inferred aggregate wasm32 guests', {
  skip:mandatory?false:'requires real guest release gate: npm run test:aggregate-real-guest'
},async()=>{
  assert.ok(compiler,'real aggregate Wasm32 gate requires ORESLANG_LLVM_COMPILER');
  const compilerPath=resolve(compiler);
  const digest=createHash('sha256').update(await readFile(compilerPath)).digest('hex');
  assert.deepEqual(cases.map(x=>x[2]),[42,43,44],
    'different programs must not all accept an arbitrary constant-returning compiler');
  for(const [name,sourceText,expected] of cases){
    const dir=await mkdtemp(join(tmpdir(),'atto-wasm-aggregate-'));
    try{
      const source=join(dir,'program.atto');
      const output=join(dir,'program.wasm');
      await writeFile(source,sourceText,{flag:'wx'});
      await compileOresToWasm({
        compiler:compilerPath,compilerSha256:digest,source,output,clang,
        experimentalStackAggregate:true,publication:'legacy'
      });
      const binary=await readFile(output);
      const module=new WebAssembly.Module(binary);
      const instance=new WebAssembly.Instance(module,{});
      assert.equal(instance.exports.main(),BigInt(expected),name);
      assert.equal(await readFile(source,'utf8'),sourceText,
        'compiler modified source for '+name);
    }finally{await rm(dir,{recursive:true,force:true});}
  }
  // Negative controls must use the SAME real compiler and pinned compiler
  // bytes; no mock/stdout heuristic can count as native compiler rejection.
  for(const [name,sourceText] of rejectedCases){
    const dir=await mkdtemp(join(tmpdir(),'atto-wasm-aggregate-negative-'));
    try{
      const source=join(dir,'reject.atto');
      const output=join(dir,'reject.wasm');
      await writeFile(source,sourceText,{flag:'wx'});
      await assert.rejects(
        compileOresToWasm({compiler:compilerPath,compilerSha256:digest,
          source,output,clang,experimentalStackAggregate:true,publication:'legacy'}),
        /command failed|unsupported|diagnostic|rejected|invalid|error/i,
        name+' must be rejected by the actual compiler');
      assert.deepEqual((await (await import('node:fs/promises')).readdir(dir)).sort(),
        ['reject.atto'],name+' must leave no wasm/IR/release artifacts');
      assert.equal(await readFile(source,'utf8'),sourceText,
        name+' must not mutate rejected source');
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});
