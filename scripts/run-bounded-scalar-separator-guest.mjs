#!/usr/bin/env node
// Strict no-import scalar subset of atto.browser.guest.v2. No memory is
// exported by pure scalar guests; the separate exceptional runner is unchanged.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
try {
  const bytes=readFileSync(0);
  assert.ok(bytes.length>=8 && bytes.length<=1024*1024);
  assert.ok(WebAssembly.validate(bytes));
  const module=new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module),[]);
  assert.deepEqual(WebAssembly.Module.exports(module).sort((a,b)=>a.name.localeCompare(b.name)),
    [{name:'main',kind:'function'},{name:'panic_code',kind:'global'}]);
  const instance=new WebAssembly.Instance(module,{});
  assert.equal(typeof instance.exports.main,'function');
  const value=instance.exports.main();
  assert.equal(typeof value,'bigint');
  assert.ok(instance.exports.panic_code instanceof WebAssembly.Global);
  assert.equal(instance.exports.panic_code.value,0);
  process.stdout.write(JSON.stringify({scope:'ISOLATED_SCALAR_SEPARATOR_GUEST',value:String(value),stdout:''})+'\n');
} catch (error) {
  process.stderr.write('SCALAR_GUEST_REJECTED: '+String(error?.message??error).slice(0,512)+'\n');
  process.exitCode=1;
}
