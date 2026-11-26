import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const module=new WebAssembly.Module(readFileSync(process.argv[2]));assert.deepEqual(WebAssembly.Module.imports(module),[]);
const e=new WebAssembly.Instance(module,{}).exports;assert.equal(e.atto_scalar_size_v1(),47n);assert.equal(e.atto_scalar_fields_v1(),3n);
const p=Number(e.__heap_base.value),b=p+64,out=p+128;assert.ok(out+24<=e.memory.buffer.byteLength);
const m=new Uint8Array(e.memory.buffer),d=new DataView(e.memory.buffer);const write=(where,v)=>v.forEach((x,i)=>d.setBigInt64(where+i*8,x,true));const read=where=>Array.from({length:3},(_,i)=>d.getBigInt64(where+i*8,true));
assert.equal(e.atto_scalar_initial_v1(b,47n),47n);assert.equal(Buffer.from(m.slice(b,b+47)).toString('hex'),'4154544f5354303101f9b8eff04a5474590300010000000000000080020101ffffffffffffff7f4191e1156e4df645');
assert.equal(e.atto_scalar_decode_v1(b,47n,out,3n),3n);assert.deepEqual(read(out),[-(1n<<63n),1n,(1n<<63n)-1n]);
for(let i=-5000n;i<=5000n;i++){const v=[i,i%2n===0n?1n:0n,-i];write(p,v);assert.equal(e.atto_scalar_encode_v1(p,3n,b,47n),47n);assert.equal(e.atto_scalar_decode_v1(b,47n,out,3n),3n);assert.deepEqual(read(out),v);}
const valid=m.slice(b,b+47);write(out,[999n,999n,999n]);for(let i=0;i<47;i++){assert.equal(e.atto_scalar_decode_v1(b,BigInt(i),out,3n),-1n);for(let bit=0;bit<8;bit++){m.set(valid,b);m[b+i]^=1<<bit;assert.equal(e.atto_scalar_decode_v1(b,47n,out,3n),-1n);assert.deepEqual(read(out),[999n,999n,999n]);}}m.set(valid,b);m[b+29]=2;let h=0xcbf29ce484222325n;for(const x of m.subarray(b,b+39))h=BigInt.asUintN(64,(h^BigInt(x))*0x100000001b3n);d.setBigUint64(b+39,h,true);assert.equal(e.atto_scalar_decode_v1(b,47n,out,3n),-1n);assert.deepEqual(read(out),[999n,999n,999n]);
m.set(valid,b);write(p,[1n,2n,3n]);assert.equal(e.atto_scalar_encode_v1(p,3n,b,47n),-1n);assert.deepEqual(m.slice(b,b+47),valid);assert.throws(()=>e.memory.grow(1));
console.log('LLVM_WASM_SCALAR_CODEC_PASS roundtrips=10001 bitflips=376');
