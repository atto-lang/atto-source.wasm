// Exact source identity + independent host arithmetic oracle; NOT Atto execution.
// These scalar decisions convey no allocation or physical retirement authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const pins={
 'core/arena_limits':'5928e893a2ce1baadb0376a4ccb14f63249f77d4',
 'alloc/arena_lifecycle':'e4795c6d4bd561be3d913cdc617d103d0e2828c8'
};
for(const [path,pin] of Object.entries(pins))test('exact reference '+path,()=>{
 const b=readFileSync(new URL('../stdlib/policy/'+path+'.atto',import.meta.url));
 assert.equal(createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),pin);
});
test('quota placement model matches independent widened oracle',()=>{
 const M=(1n<<63n)-1n;
 const edges=[-1n,0n,1n,2n,3n,7n,8n,9n,15n,16n,17n,255n,256n,1n<<62n,M-1n,M];
 const aligns=[-1n,0n,1n,2n,3n,4n,8n,16n,32n,1n<<62n,M];
 const model=(cursor,count,alignment,limit)=>{
   if(cursor<0n||count<0n||limit<0n||cursor>limit||alignment<=0n||(alignment&(alignment-1n))!==0n)return -1n;
   const r=cursor-(cursor/alignment)*alignment,pad=r===0n?0n:alignment-r;
   if(count===0n)return cursor;
   if(pad>limit-cursor)return -1n;
   const start=cursor+pad;
   return count>limit-start?-1n:start+count;
 };
 const legalAlign=new Set(Array.from({length:63},(_,i)=>1n<<BigInt(i)));
 const oracle=(c,n,a,q)=>{
   if(c<0n||n<0n||q<0n||c>q||!legalAlign.has(a))return -1n;
   if(n===0n)return c;
   const e=((c+a-1n)/a)*a+n;
   return e>q?-1n:e;
 };
 let cases=0;
 for(const c of edges)for(const n of edges)for(const a of aligns)for(const q of edges){
   const end=model(c,n,a,q);assert.equal(end,oracle(c,n,a,q));
   if(end>=0n){assert.ok(end>=c&&end<=q);if(n===0n)assert.equal(end,c);}
   cases++;
 }
 assert.equal(cases,45056);
});
test('retirement requires sealed admission, completed drops and all five counters zero',()=>{
 let cases=0;
 for(const sealed of [false,true])for(const drops of [false,true]){
  for(let i=0;i<243;i++){
   let x=i;const counters=Array.from({length:5},()=>{const n=x%3-1;x=Math.floor(x/3);return n;});
   const model=sealed&&drops&&counters.every(n=>n===0);
   assert.equal(model,sealed&&drops&&i===121);
   cases++;
  }
 }
 assert.equal(cases,972);
});
test('generation policy never wraps or reuses zero',()=>{
 const M=(1n<<63n)-1n,edges=[-1n,0n,1n,2n,3n,M-1n,M];
 for(const g of edges)for(const cap of edges){
  const next=g<1n||cap<2n||g>=cap?-1n:g+1n;
  assert.equal(next,g>=1n&&g+1n<=cap?g+1n:-1n);
 }
});
