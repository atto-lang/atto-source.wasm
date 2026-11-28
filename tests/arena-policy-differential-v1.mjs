// Deterministic differential quota/lifecycle corpus. The oracle widens to BigInt.
// No generated host implementation is substituted for the compiled guest.
export function arenaPolicyCases() {
 const max=(1n<<63n)-1n,min=-(1n<<63n),mask=(1n<<64n)-1n;
 let state=0x8b5ad4cef1342301n;
 const next=()=>{state=(state*6364136223846793005n+1442695040888963407n)&mask;return state;};
 const edge=[min,-1n,0n,1n,2n,3n,7n,8n,9n,15n,16n,17n,255n,256n,1n<<62n,max-1n,max];
 const lit=n=>n===min?'(0 - 9223372036854775807 - 1)':n<0n?'(0 - '+(-n)+')':String(n);
 const alignment=[-1n,0n,1n,2n,3n,4n,8n,16n,31n,32n,1n<<62n,max];
 const legal=new Set(Array.from({length:63},(_,i)=>1n<<BigInt(i)));
 const pick=a=>a[Number(next()%BigInt(a.length))];
 const wide=()=>next()&max;
 const quota=(c,n,a,q)=>{
   if(c<0n||n<0n||q<0n||c>q||!legal.has(a))return -1n;
   if(n===0n)return c;
   const end=((c+a-1n)/a)*a+n;
   return end>q?-1n:end;
 };
 const cases=[];
 const add=(name,args,value)=>cases.push({call:name+'('+args.map(a=>typeof a==='boolean'?String(a):lit(a)).join(', ')+')',expected:typeof value==='boolean'?String(value):lit(value)});
 for(let i=0;i<256;i++){
   const a=i%3===0?1n<<BigInt(Number(next()%63n)):pick(alignment);
   const c=i%4===0?wide():pick(edge),n=i%5===0?wide():pick(edge);
   const q=i%3===0?max:i%3===1?wide():pick(edge);
   add('arena_end_offset',[c,n,a,q],quota(c,n,a,q));
 }
 // Cover every combination of the five counters with a sealed, drained arena.
 for(let bits=0;bits<32;bits++){
   const counters=Array.from({length:5},(_,i)=>BigInt((bits>>i)&1));
   for(const sealed of [false,true])add('arena_can_free',[sealed,true,...counters],sealed&&bits===0);
 }
 for(let i=0;i<32;i++){const g=pick(edge),cap=pick(edge);add('arena_next_generation',[g,cap],g>=1n&&cap>=2n&&g<cap?g+1n:-1n);}
 return cases;
}
export function arenaPolicyBatches() {
 const cases=arenaPolicyCases(), batches=[];
 for(let start=0;start<cases.length;start+=16){
   const chunk=cases.slice(start,start+16);
   const lines=chunk.map(({call,expected},i)=>'  if '+call+' != '+expected+' then return '+(i+1)+'; fi');
   batches.push({source:'pub fnc main(): int {\n'+lines.join('\n')+'\n  return 100;\n}\n',count:chunk.length,start});
 }
 return batches;
}
