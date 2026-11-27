import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

const head='c54fe21ee854cbcd827fdb53ac92ac67b3f11ece';
const tree='a6de7016b614763cd2e8f37e833bca20502fe3e6';
const required=process.env.ATTO_RECUR_BROWSER_REQUIRED==='1';
const positives=[
 ['pass/220-recur-sum.atto','adf984b7e7c7e1dd864460e89db50e47f0ee50dd',45n],
 ['pass/221-recur-parallel-fibonacci.atto','5ea7a41aa0052b55ff6d10eebce7561dbe78fe8b',13n],
 ['pass/222-recur-branch-else.atto','45e590a6e0eb0bea544ccad2dc9c829580557b6f',3n],
 ['pass/240-recur-inferred-state-swap.atto','1c4554ba1fd671d72cc3560a2c2f8817ef5e477b',42n],
 ['pass/241-recur-inferred-state-mixed-primitives.atto','81bfc852e9f8586aabd48291caf3c3cc8d8ee428',42n],
 ['pass/238-recur-ten-million-full-i64.atto','5cc0a0662fa079e2ef5957003ad598a196771993',49999995000000n]
];
const negatives=[
 ['fail/253-recur-inferred-state-forward-reference.atto','23e8bbb3857ba30f512ce915dcca783465c9cf1d','E_UNSUPPORTED'],
 ['fail/254-recur-inferred-state-replacement-type.atto','5c77b9f7c2b647d1da252b5963a7b332a9f178b1','E_TYPE']
];
test('delegated browser compiler executes pinned immutable-state recur corpus',{skip:!required,timeout:30000},async()=>{
 const root=process.env.ATTO_BROWSER_SOURCE_ROOT;
 assert.ok(root&&isAbsolute(root),'exact compiler checkout required');
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:5000}).trim();
 assert.equal(git('rev-parse','HEAD'),head);
 assert.equal(git('rev-parse','HEAD^{tree}'),tree);
 assert.equal(git('status','--porcelain','--untracked-files=no'),'');
 assert.equal(process.env.ATTO_BROWSER_SOURCE_SHA,head);
 assert.equal(process.env.ATTO_BROWSER_SOURCE_TREE,tree);
 const digest=process.env.ATTO_BROWSER_COMPILER_SHA256;
 assert.match(digest??'',/^[a-f0-9]{64}$/);
 assert.ok(process.env.ATTO_BROWSER_COMPILER);
 const bytes=await readFile(process.env.ATTO_BROWSER_COMPILER);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
 await verifyCompilerBytes(bytes,digest,bytes.length);
 const compiler=await createCompiler(bytes);
 const source=async(path,sha)=>{
   const raw=await readFile(join(root,'tests/fixtures',path));
   assert.equal(createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex'),sha,path);
   return raw.toString('utf8');
 };
 const execute=(result,expected)=>{
   assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
   const mod=new WebAssembly.Module(result.wasm);
   assert.deepEqual(WebAssembly.Module.imports(mod),[]);
   const instance=new WebAssembly.Instance(mod,{});
   assert.equal(instance.exports.main(),expected);
   assert.equal(instance.exports.panic_code.value,0);
 };
 for(const [path,sha,expected] of positives)execute(compiler.compile(await source(path,sha)),expected);
 for(const [path,sha,diagnostic] of negatives){
   const result=compiler.compile(await source(path,sha));
   assert.equal(result.ok,false,path);
   assert.equal('wasm' in result,false,path);
   assert.ok(result.diagnostics[0].message.includes(diagnostic),JSON.stringify(result.diagnostics));
   execute(compiler.compile('pub fnc main(): int { return 42; }'),42n);
 }
});
