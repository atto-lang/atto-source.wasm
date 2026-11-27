// Internal compiler/host analysis only; no guest authority or continuation lowering.
export const EXPLICIT_SUSPEND=1, RUNTIME_PARK=2, UNRESOLVED=4;
export function parkingPolicy(bits) {
  if (!Number.isInteger(bits)||bits<0||bits>7) throw new TypeError('invalid parking effect bits');
  return {requiresResumableFrame:bits!==0,requiresSuspendAnnotation:!!(bits&1),safeWithExclusiveLoan:bits===0};
}
// Trusted, already resolved IR only. Null targets mean unresolved, not pure.
export function inferParking(nodes) {
  if(!Array.isArray(nodes)||nodes.length>1024) throw new RangeError('parking callable budget');
  const n=nodes.length, rows=new Uint8Array(n), reverse=Array.from({length:n},()=>[]);
  let edges=0;
  for(let i=0;i<n;i++){
    const node=nodes[i];
    if(!node||!Array.isArray(node.calls)) throw new TypeError('invalid parking callable');
    parkingPolicy(node.direct);
    const calls=node.calls;
    if(calls.length>1024||calls.length>16384-edges) throw new RangeError('parking edge budget');
    edges+=calls.length; rows[i]=node.direct;
    for(const target of calls){
      if(target===null) rows[i]|=UNRESOLVED;
      else if(!Number.isInteger(target)||target<0||target>=n) throw new RangeError('invalid parking target');
      else reverse[target].push(i);
    }
  }
  // Each three-bit row grows at most three times; bounded worklist.
  const work=Array.from({length:n},(_,i)=>i), queued=new Uint8Array(n).fill(1);
  for(let pos=0;pos<work.length;pos++){
    const callee=work[pos];queued[callee]=0;
    for(const caller of reverse[callee]){
      const next=rows[caller]|rows[callee];
      if(next===rows[caller])continue;
      rows[caller]=next;
      if(!queued[caller]){queued[caller]=1;work.push(caller);}
    }
  }
  return rows;
}
