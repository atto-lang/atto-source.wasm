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
  const new_row=infer record{...original,y:22};
  return new_row.x+new_row.y;
}`,42],
  ['override final type',`pub fnc main():int{
  const first=infer struct{x:true,y:40};
  const last=infer struct{...first,x:2};
  return last.x+last.y;
}`,42]
];

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const clang=process.env.CLANG || 'clang';
const enabled=!!compiler && process.env.ATTO_WASM_AGGREGATE_REAL_GUEST==='1';

test('opt-in cannot bypass compiler pin even for a valid source snapshot',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'atto-wasm-pin-'));
  try{
    const fake=join(directory,'compiler');
    const source=join(directory,'source.ores');
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
  skip:enabled?false:'requires pinned native LLVM compiler and opt-in ATTO_WASM_AGGREGATE_REAL_GUEST=1'
},async()=>{
  const compilerPath=resolve(compiler);
  const digest=createHash('sha256').update(await readFile(compilerPath)).digest('hex');
  for(const [name,sourceText,expected] of cases){
    const dir=await mkdtemp(join(tmpdir(),'atto-wasm-aggregate-'));
    try{
      const source=join(dir,'program.ores');
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
});
