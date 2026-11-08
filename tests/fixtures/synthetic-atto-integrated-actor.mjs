/** Real WebAssembly engine fixture, authored by hand to test the *shape*
 * of Rust source-actor guest ABI. It is not emitted by the Rust compiler. */
export const ATTO_FIXTURE_IMPORT='actor_spawn';
const u=n=>{const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return out;};
const txt=s=>[...u(new TextEncoder().encode(s).length),...new TextEncoder().encode(s)];
const section=(id,body)=>[id,...u(body.length),...body];
const sig=(args,returns)=>[0x60,...u(args.length),...args,...u(returns.length),...returns];
const exp=(name,kind,index)=>[...txt(name),kind,...u(index)];
const body=ops=>[...u(ops.length+1),0x00,...ops];

export function makeSyntheticAttoActorGuest({
  importModule='atto',importName=ATTO_FIXTURE_IMPORT,
  handlerSignature=0x7e,memoryFlags=1,memoryMax=1,
  withStart=false,withTable=false,withActor1=true
}={}) {
  const funcs=withActor1?3:2;
  const type=section(1,[3,...sig([0x7f],[0x7f]),...sig([],[0x7e]),
    ...sig([0x7e],[handlerSignature])]);
  const imports=section(2,[1,...txt(importModule),...txt(importName),0,0]);
  const functions=section(3,[funcs,1,...Array(funcs-1).fill(2)]);
  const table=withTable?section(4,[1,0x70,0,1]):[];
  const memory=section(5,[1,memoryFlags,1,...u(memoryMax)]);
  const globals=section(6,[2,0x7f,1,0x41,0,0x0b,
    0x7e,1,0x42,0,0x0b]);
  const exports=[...exp('main',0,1),...exp('panic_code',3,0),
    ...exp('memory',2,0),...exp('atto_actor_receive_0',0,2)];
  if(withActor1)exports.push(...exp('atto_actor_receive_1',0,3));
  const exportSec=section(7,[withActor1?5:4,...exports]);
  const start=withStart?section(8,[1]):[];
  // i64(-1) triggers an actual Wasm unreachable trap. Other messages update
  // an instance-private mutable i64 global; no host imports are invoked.
  const receive=[0x20,0,0x42,0x7f,0x51,0x04,0x40,0x00,0x0b,
    0x23,1,0x20,0,0x7c,0x24,1,0x23,1,0x0b];
  const code=section(10,[funcs,...body([0x42,0,0x0b]),
    ...body(receive),...(withActor1?body(receive):[])]);
  return Uint8Array.from([0,97,115,109,1,0,0,0,...type,...imports,
    ...functions,...table,...memory,...globals,...exportSec,...start,...code]);
}
