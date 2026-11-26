// Host-side candidate evidence only. A trusted runner must genuinely compile
// and execute the guest. Independent compiler/job/artifact provenance required.
// Linux; launch this Node process from a trusted clean parent.
import {openSync,closeSync,fstatSync,lstatSync,readSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifestPath='tests/fixtures/std-metrics-json-zorde/expected-stdout.json';
const manifestBlob='788b14be9760f3fb97044418a6f65012a7947840';
const fixtures={
  metrics:['360296191eb7ef368aef7dca555e6a9d9cbf9448',36],
  json:['cc6eb203b756ba3dbe4abb0adc76566bf3b9600d',36],
  zorde:['0f764e1f48d8cf9bc084b77566d0627d196f551e',55],
};
const fail=(message)=>{throw new Error(message);};
const require=(ok,message)=>{if(!ok)fail(message);};
const digest=(kind,bytes)=>createHash(kind).update(bytes).digest('hex');
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function safePath(p){
  require(path.isAbsolute(p)&&path.normalize(p)===p&&p.length<=4096,'noncanonical path');
  for(let d=path.dirname(p);;d=path.dirname(d)){
    require(lstatSync(d).isDirectory(),'unsafe directory ancestor');
    if(d===path.dirname(d))break;
  }
  const s=lstatSync(p,{bigint:true});
  require(s.isFile()&&s.nlink===1n,'unsafe file or link');
  return s;
}
function bounded(p,limit,collect,exec=false){
  const before=safePath(p);
  require(before.size>0n&&before.size<=BigInt(limit),'file size outside bound');
  if(exec)require((before.mode&0o111n)!==0n,'runner not executable');
  const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    require(stamp(fstatSync(fd,{bigint:true}))===stamp(before),'file changed on open');
    const buf=Buffer.alloc(65536),parts=[],h=createHash('sha256');let total=0;
    for(;;){
      const n=readSync(fd,buf,0,Math.min(buf.length,Number(before.size)+1-total),null);
      if(!n)break;
      total+=n;require(total<=Number(before.size),'file grew');
      h.update(buf.subarray(0,n));if(collect)parts.push(Buffer.from(buf.subarray(0,n)));
    }
    require(total===Number(before.size)&&stamp(fstatSync(fd,{bigint:true}))===stamp(before)&&stamp(safePath(p))===stamp(before),'file changed on read');
    return {hash:h.digest('hex'),bytes:collect?Buffer.concat(parts,total):null,stamp:stamp(before)};
  }finally{closeSync(fd);}
}
function text(b){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);}
function run(){
  const [runner,pin,...extra]=process.argv.slice(2);
  require(process.platform==='linux'&&constants.O_NOFOLLOW&&constants.O_NONBLOCK,'Linux no-follow support required');
  require(extra.length===0&&runner&&/^[0-9a-f]{64}$/.test(pin??''),'absolute trusted runner and SHA256 required');
  const checkRunner=()=>{const b=bounded(runner,512*1024*1024,false,true);require(b.hash===pin,'runner digest mismatch');return b.stamp;};
  const identity=checkRunner();
  const check=()=>{
    const raw=bounded(path.join(root,manifestPath),1024*1024,true).bytes;
    require(blob(raw)===manifestBlob,'golden manifest changed');
    const m=JSON.parse(text(raw));
    require(m.schema==='atto.stdlib.metrics-json-zorde.guest-stdout-v1'&&m.status==='REFERENCE_NOT_EXECUTED_ON_THIS_BACKEND','wrong manifest');
    for(const [name,[sha,count]] of Object.entries(fixtures)){
      const expectedPath='tests/fixtures/std-metrics-json-zorde/'+name+'.atto',v=m.fixtures?.[name];
      require(v?.path===expectedPath&&v.git_blob_sha===sha&&Array.isArray(v.stdout_lines)&&v.stdout_lines.length===count&&v.stdout_lines.every(s=>typeof s==='string'),'wrong fixture manifest');
      require(blob(bounded(path.join(root,expectedPath),1024*1024,true).bytes)===sha,'fixture changed: '+name);
    }
    return m;
  };
  const m=check();let checked=0;
  for(const name of Object.keys(fixtures)){
    require(checkRunner()===identity,'runner identity changed');check();
    const v=m.fixtures[name];
    const result=spawnSync(runner,[path.join(root,v.path)],{
      shell:false,cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},
      timeout:45000,killSignal:'SIGKILL',maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']
    });
    require(!result.error&&!result.signal&&result.status===0,'runner failed or timed out: '+name);
    require(checkRunner()===identity,'runner identity changed');check();
    const out=text(result.stdout).replace(/\r\n/g,'\n');
    const actual=(out.endsWith('\n')?out.slice(0,-1):out).split('\n');
    require(JSON.stringify(actual)===JSON.stringify(v.stdout_lines),'guest stdout mismatch: '+name);
    checked+=actual.length;
  }
  require(checked===127,'missing expected guest lines');
  console.log('ATTO_STDLIB_CANDIDATE_GUEST_STDOUT_MATCH=127');
  console.log('ATTO_STDLIB_PARITY=NOT_VERIFIED_EXTERNAL_PROVENANCE_REQUIRED');
}
try{run();}catch(e){console.error('ATTO_STDLIB_GUEST=NOT_VERIFIED: '+e.message);process.exitCode=1;}
