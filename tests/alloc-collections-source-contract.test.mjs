// Host-side source contract only. NOT a compiled Atto guest or AOT test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=(f)=>readFileSync(new URL('../stdlib/alloc/'+f+'.atto',import.meta.url),'utf8');
const fixture=(f)=>readFileSync(new URL('./fixtures/alloc-collections-source/'+f+'.atto',import.meta.url),'utf8');

test('Box requires explicit ownership transfer and forbids raw handle forging',()=>{
 const b=source('box');
 assert.match(b,/boxed<T>\(take! T value\)/);
 assert.match(b,/replace\(take! T next\)/);
 assert.match(b,/let Option<T> previous = take! self\.slot/);
 assert.match(b,/self\.slot = None/);
 assert.doesNotMatch(b,/unsafe|from_raw|transmute|raw_ptr/);
});
test('Vec reserves actual ownership for consuming operation and Copy for reads',()=>{
 const v=source('vec');
 assert.match(v,/push\(take! T item\)/);
 assert.match(v,/push_copy\(T item\)/);
 assert.match(v,/self\.values\.add\(copy! item\)/);
 assert.match(v,/index < 0 \|\| index >= self\.values\.size/);
 assert.match(v,/capacity > max_capacity - capacity/);
 assert.doesNotMatch(v,/unsafe|from_raw|transmute|raw_ptr/);
});
test('String stages writes and admits only valid UTF-8 scalars',()=>{
 const s=source('string');
 assert.match(s,/fnc append_encoded_scalar_unchecked\(/);
 assert.doesNotMatch(s,/pub fnc append_encoded_scalar_unchecked/);
 assert.match(s,/!valid_scalar\(scalar\) \|\| !valid_utf8\(self\.bytes\)/);
 assert.match(s,/n > 9223372036854775807 - width/);
 const a=s.indexOf('let mut Array<int> staged = new Array<int>()');
 const b=s.indexOf('append_encoded_scalar_unchecked(borrow! mut staged, scalar)');
 const c=s.indexOf('self.bytes = take! staged');
 assert.ok(a>=0 && a<b && b<c,'buffer commit must occur after staged encoding');
 assert.match(s,/a == 224 && \(b < 160 \|\| b > 191\)/);
 assert.match(s,/a == 237 && \(b < 128 \|\| b > 159\)/);
 assert.match(s,/a == 244 && \(b < 128 \|\| b > 143\)/);
});
test('Atto fixtures include use-after-move and illegal UTF-8 rejection',()=>{
 assert.match(fixture('reject-use-after-take'),/take! owned/);
 assert.match(fixture('reject-use-after-take'),/return owned\.is_full/);
 const u=fixture('utf8-contract');
 for (const name of ['overlong','surrogate','too_large','truncated','bad_byte','isolated']) assert.ok(u.includes(name));
});
function growth(cur,needed,max,floor){
 if(cur<0n||needed<0n||max<0n||cur>max||needed>max)return null;
 if(needed<=cur)return cur;
 let n=cur<floor?floor:cur;
 if(n>max)n=max;
 while(n<needed)n=n>max-n?max:n+n;
 return n;
}
test('backend growth profile over 48k cases and i64 extremes',()=>{
 const floorMatch=source('vec').match(/if capacity < (\d+); do/);
 assert.ok(floorMatch,'growth floor in native Atto source');
 const floor=BigInt(floorMatch[1]);
 assert.ok([2n,4n,8n,16n].includes(floor));
 const maxI64=9223372036854775807n;
 assert.equal(growth(maxI64-1n,maxI64,maxI64,floor),maxI64);
 assert.equal(growth(32n,41n,40n,floor),null);
 let x=12345;
 for(let i=0;i<48000;i++){
  x=(Math.imul(x,1664525)+1013904223)>>>0;
  const max=BigInt(x%2000),cur=BigInt((x>>>8)%2100),needed=BigInt((x>>>16)%2100);
  const got=growth(cur,needed,max,floor);
  if(got===null)assert.ok(cur>max||needed>max);
  else assert.ok(got>=cur&&got>=needed&&got<=max);
 }
});
test('strict UTF-8 reference decoder vectors',()=>{
 const mustReject=[[0x80],[0xc0,0x80],[0xe0,0x80,0x80],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xf5,0x80,0x80,0x80],[0xf0,0x9f,0x98]];
 const mustAccept=[[],[0],[0xe2,0x82,0xac],[0xf0,0x9f,0x98,0x80],[0xf4,0x8f,0xbf,0xbf]];
 const dec=(b)=>{try{new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(b));return true}catch{return false}};
 for(const b of mustReject)assert.equal(dec(b),false);
 for(const b of mustAccept)assert.equal(dec(b),true);
});
