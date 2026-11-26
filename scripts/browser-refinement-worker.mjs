import {runRefinementCases} from './browser-refinement-corpus.mjs';
import {verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';
self.onmessage=async ({data})=>{
 try{
  if(!(self instanceof DedicatedWorkerGlobalScope)||typeof document!=='undefined'||!self.isSecureContext)throw Error('expected secure dedicated browser Worker');
  const response=await fetch('/compiler.wasm',{cache:'no-store'});
  if(!response.ok)throw Error('compiler fetch failed');
  const bytes=new Uint8Array(await response.arrayBuffer());
  let denied=false;
  const wrong=(data.pin[0]==='0'?'1':'0')+data.pin.slice(1);
  try{await verifyCompilerBytes(bytes,wrong,bytes.length);}catch(e){denied=/sha256/.test(e.message);}
  if(!denied)throw Error('incorrect compiler digest admitted');
  const typed=data.typed?(await import('/typed-binding-corpus.mjs')).typedBindingCases:null;
  const report=await runRefinementCases(bytes,data.pin,data.head,data.tree,line=>self.postMessage({line}),typed);
  self.postMessage({ok:true,...report,integrityNegative:true,worker:true,agent:navigator.userAgent});
 }catch(e){self.postMessage({ok:false,error:String(e?.stack??e)});}
};
