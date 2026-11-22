// Source-only model: transpiles a deliberately narrow .atto class subset.
// This is NOT Atto parsing/typechecking, guest execution, host UDP, or AOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const library = readFileSync(new URL('../stdlib/net/udp_stream_budget.atto',import.meta.url),'utf8');
const guest = readFileSync(new URL('./fixtures/udp-stream-budget-main.atto',import.meta.url),'utf8');

function asJavaScript(source) {
  const unannotated=source.replace(/\/\/[^\n]*/g,'');
  const result=unannotated
    .replace(/\bdefine module UdpStream as\b/g,'const UdpStream = (() => {')
    .replace(/\bdefine pub class Budget as\b/g,'class Budget {')
    .replace(/\bmut int (\w+) =/g,'$1 =')
    .replace(/\bconstructor\(([^)]*)\)/g,(_,s)=>'constructor('+argumentsOf(s)+')')
    .replace(/\bpub fnc budget\(([^)]*)\): Budget \{/g,(_,s)=>'function budget('+argumentsOf(s)+') {')
    .replace(/\bpub fnc main\(\): int \{/g,'function main() {')
    .replace(/\bpub (\w+)\(([^)]*)\): (?:bool|int|void) \{/g,(_,name,s)=>name+'('+argumentsOf(s)+') {')
    .replace(/\bif ([^\n]+?) then return ([^\n]+?); fi/g,(_,cond,val)=>'if ('+cond+') { return '+val+'; }')
    .replace(/\bif ([^\n]+?) then/g,(_,cond)=>'if ('+cond+') {')
    .replace(/^\s*fi\b/gm,'}')
    .replace(/^\s*end\b/gm,'}')
    .replace(/\bself\b/g,'this')
    .replace(/(?<![A-Za-z_])([0-9]+)(?![A-Za-z_])/g,'$1n');
  if (/\b(?:define|fnc|fi|then|self|mut int)\b/.test(result))
    throw new Error('unsupported Atto syntax in stateful model');
  return result;
}
function argumentsOf(parameters) {
  return parameters.split(',').map(s=>s.trim().split(/\s+/).at(-1)).filter(Boolean).join(',');
}
function load(source) {
  const converted=asJavaScript(source).replace(/\n\}\s*$/,'\nreturn {budget};\n})();');
  const env=Object.create(null);
  runInNewContext(converted,env,{timeout:2000});
  return env.UdpStream;
}

const MAX=9223372036854775807n;
class Reference {
  constructor(packets,bytes) {
    this.maxPackets=packets;this.maxBytes=bytes;this.packets=0n;this.bytes=0n;this.dropped=0n;
  }
  record_drop() {
    if(this.dropped<2147483647n)this.dropped++;
  }
  try_admit(bytes) {
    if(this.maxPackets<1n||this.maxPackets>65536n||
       this.maxBytes<1n||this.maxBytes>16777216n||
       this.packets<0n||this.bytes<0n||bytes<0n||bytes>65527n)return false;
    if(this.packets>=this.maxPackets||this.bytes<=this.maxBytes&&bytes>this.maxBytes-this.bytes){
      this.record_drop();return false;
    }
    if(this.bytes>this.maxBytes)return false;
    this.packets++;this.bytes+=bytes;return true;
  }
  release(bytes) {
    if(this.packets<=0n||this.bytes<0n||bytes<0n||bytes>this.bytes)return false;
    this.packets--;this.bytes-=bytes;return true;
  }
}

test('29 source-model stateful guest fixture checks return 42',()=>{
  const sandbox=Object.create(null);
  runInNewContext(asJavaScript(library).replace(/\n\}\s*$/,'\nreturn {budget};\n})();')+
     '\n'+asJavaScript(guest),sandbox,{timeout:2000});
  assert.equal((guest.match(/\bif /g)??[]).length,29);
  assert.equal(sandbox.main(),42n);
});

test('512 deterministic state traces agree with independent queue oracle',()=>{
  const module=load(library);
  let seed=0x26a47511;
  function pick(arr) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return arr[(seed>>>16)%arr.length];
  }
  const maxPackets=[-1n,0n,1n,2n,3n,65536n,65537n];
  const maxBytes=[-1n,0n,1n,4n,65527n,16777216n,16777217n];
  const payload=[-1n,0n,1n,2n,3n,4n,5n,65507n,65527n,65528n,MAX];
  for(let trace=0;trace<512;trace++){
    const p=pick(maxPackets),b=pick(maxBytes);
    const actual=module.budget(p,b),expected=new Reference(p,b);
    for(let op=0;op<32;op++){
      const value=pick(payload);
      const choice=Number(pick([0n,1n,2n]));
      const prefix='trace '+trace+', op '+op;
      if(choice===0)assert.equal(actual.try_admit(value),expected.try_admit(value),prefix+' admit');
      else if(choice===1)assert.equal(actual.release(value),expected.release(value),prefix+' release');
      else {actual.record_drop();expected.record_drop()}
      assert.equal(actual.queued_packets(),expected.packets,prefix+' packet count');
      assert.equal(actual.queued_bytes(),expected.bytes,prefix+' byte count');
      assert.equal(actual.dropped_packets(),expected.dropped,prefix+' dropped count');
    }
  }
});

test('negative mutation proves full-queue admission is detected',()=>{
  const token='if self.packets >= self.max_packets then';
  assert.ok(library.includes(token));
  const changed=library.replace(token,'if self.packets < 0 then');
  const safe=load(library).budget(1n,1n);
  const unsafe=load(changed).budget(1n,1n);
  assert.equal(safe.try_admit(0n),true);
  assert.equal(unsafe.try_admit(0n),true);
  assert.equal(safe.try_admit(0n),false);
  assert.equal(unsafe.try_admit(0n),true);
});
