import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';
import {runCanonicalGuest} from '../src/browser-tenant-runtime.mjs';
const bytes=await readFile(new URL('../test-support/canonical-compiler.wasm',import.meta.url));
const compiler=await createCompiler(bytes);
const source=`define actor Counter as
  let int total = 0;
  receive(ActorMail<int> mail): void {
    self.total = self.total + mail.value;
    stdio.println(self.total); return;
  }
end
pub fnc main(): int {
  val a = spawn Counter(); val b = spawn Counter();
  a.send(40); a.send(2); b.send(7); return 0;
}`;
test('canonical .atto actors execute in ESM and Wasm with identical stdout',async()=>{
  const js=compiler.compile(source,'javascript'),wasm=compiler.compile(source);
  assert.equal(js.ok,true);assert.equal(wasm.ok,true);
  const ns=await import('data:text/javascript,'+encodeURIComponent(js.esm));
  const a=runCanonicalGuest(ns);
  const mod=new WebAssembly.Module(wasm.wasm);
  const b=runCanonicalGuest({actorNames:ns.actorNames,instantiate:atto=>new WebAssembly.Instance(mod,{atto})});
  assert.deepEqual(a,b);
  assert.deepEqual([a.ok,a.stdout,a.actors,a.privateMemories],[true,'40\n42\n7\n',2,3]);
});
test('same checker rejects unsupported/malformed source without either artifact',()=>{
  for(const source of ['pub fnc main(): int { return missing; }', 'define actor Bad as receive(ActorMail<int> mail): void { self.missing = 1; return; } end pub fnc main(): int { return 0; }']){
    for(const target of ['wasm','javascript']){const r=compiler.compile(source,target);assert.equal(r.ok,false);assert.equal('wasm' in r,false);assert.equal('esm' in r,false);}
  }
});
test('shared frontend preserves checked overflow and compiler integrity',async()=>{
  const js=compiler.compile('pub fnc main(): int { return 9223372036854775807 + 1; }','javascript');
  const ns=await import('data:text/javascript,'+encodeURIComponent(js.esm));
  assert.match(runCanonicalGuest(ns).message,/integer overflow/);
  const digest=createHash('sha256').update(bytes).digest('hex');
  await verifyCompilerBytes(bytes,digest,bytes.length);
  const mutant=Buffer.from(bytes);mutant[mutant.length-1]^=1;
  await assert.rejects(verifyCompilerBytes(mutant,digest,bytes.length),/sha256/);
});
test('canonical artifact receipt binds exact compiler bytes to source repo/path',async()=>{
  const receipt=JSON.parse(await readFile(new URL('../test-support/canonical-compiler.receipt.json',import.meta.url)));
  assert.equal(receipt.source_repository,'ores-truffle-oreslang/oreslang-source.rs');
  assert.equal(receipt.source_path,'browser');
  assert.match(receipt.source_head,/^[a-f0-9]{40}$/);assert.match(receipt.source_tree,/^[a-f0-9]{40}$/);
  assert.equal(receipt.compiler_sha256,createHash('sha256').update(bytes).digest('hex'));
});
