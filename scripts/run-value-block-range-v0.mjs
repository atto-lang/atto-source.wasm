#!/usr/bin/env node
// Compiled-guest adapter for the proposed AttoLang value-block/range contract.
// NOT enabled by default: until the real compiler supports the syntax it fails.
// Environment:
//   ATTO_VBR_COMPILE_ARGV_JSON: ["compiler","--out","{artifact}","{source}"]
//   ATTO_VBR_RUN_ARGV_JSON:     ["{artifact}"] (or ["wasmtime","{artifact}"])
//   ATTO_VBR_LEX_ARGV_JSON:     ["compiler","--lex-json","{source}"]
//   ATTO_VBR_TYPECHECK_ARGV_JSON: ["compiler","--typecheck-json","{source}"]
//   ATTO_VBR_PARSE_ARGV_JSON:   ["compiler","--parse","{source}"]
//   ATTO_VBR_ARTIFACT_EXT:     e.g. ".wasm" or ".dll", default ".bin"
//   ATTO_VBR_LANE:             java-interpreter | java-native-image | llvm-native |
//                              wasm32 | forge-native | net-native-aot |
//                              rs-native | cranelift-native | js-worker |
//                              hdl-rtl-simulation
// No shell expansion, no host-language simulation and no skipped cases.
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const manifestPath=join(root,'contracts/value-block-range-v0/cases.json');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
const validLanes=[
  'java-interpreter','java-native-image','llvm-native','wasm32','forge-native',
  'net-native-aot','rs-native','cranelift-native','js-worker','hdl-rtl-simulation'
];
const lane=process.env.ATTO_VBR_LANE;
const ext=process.env.ATTO_VBR_ARTIFACT_EXT||'.bin';
const sha256=x=>createHash('sha256').update(x).digest('hex');
const validSha=/^[0-9a-f]{40}$/;
const observations=[];
let failures=0;

function requireArgv(key,placeholder){
  const raw=process.env[key];
  if(!raw) throw Error(key+' is required to execute real compiler tests; no host-only fallback');
  const args=JSON.parse(raw);
  if(!Array.isArray(args)||args.length<1||!args.every(x=>typeof x==='string'&&x.length>0))
    throw Error(key+' must be a nonempty JSON array of argv strings');
  if(!args.some(x=>x.includes(placeholder)))
    throw Error(key+' must include '+placeholder);
  return args;
}
function spawn(argv,substitutions) {
  const a=argv.map(s=>s.replace(/\{(source|artifact|case)\}/g,(_,key)=>substitutions[key]));
  const r=spawnSync(a[0],a.slice(1),{
    encoding:'utf8',shell:false,cwd:root,timeout:120000,maxBuffer:2*1024*1024,
    env:{...process.env, ATTO_VALUE_BLOCK_RANGE_CASE:substitutions.case}
  });
  if(r.error) throw Error('process failed: '+r.error.message);
  if(!Number.isInteger(r.status)) throw Error('compiler or guest was killed by signal/timeout');
  return {exit:r.status,stdout:r.stdout||'',stderr:r.stderr||''};
}
function check(output,ok,why) {
  if(!ok) throw Error(why+' (status='+output?.exit+') '+((output?.stderr||'')+' '+(output?.stdout||'')).slice(0,800));
}
function testCase(vector,compileArgv,runArgv,lexArgv,typecheckArgv,parseArgv,directory) {
  const name=vector.id;
  const source=join(directory,name+'.atto');
  const artifact=join(directory,name+ext);
  writeFileSync(source,vector.source,'utf8');
  const params={source,artifact,case:name};
  const base={id:name,kind:vector.kind,source_sha256:sha256(vector.source)};
  const assertSourceIntact=()=>{
    if(!existsSync(source)||sha256(readFileSync(source))!==base.source_sha256)
      throw Error('compiler modified or removed canonical guest source fixture');
  };
  if(existsSync(artifact)) throw Error('non-fresh artifact path (fail closed)');
  if(vector.kind==='accept_lex') {
    if(!lexArgv) throw Error('ATTO_VBR_LEX_ARGV_JSON is required: lex vectors cannot be skipped');
    const out=spawn(lexArgv,params);
    assertSourceIntact();
    check(out,out.exit===0,'real lexer must accept source');
    let result; try { result=JSON.parse(out.stdout); }
    catch { throw Error('lex mode must emit JSON on stdout'); }
    const types=Array.isArray(result) ? result : result?.tokens;
    const expected=vector.expect.token_prefix;
    if(!Array.isArray(types)||!expected.every((token,i)=>types[i]===token)||
        (types.length!==expected.length &&
         !(types.length===expected.length+1 && types.at(-1)==='EOF')))
      throw Error('lex tokens mismatch: '+JSON.stringify(types));
    if(existsSync(artifact)) throw Error('lexer published executable artifact');
    return {...base,phase:'lex',lex_pass:true,lex_tokens:types,status:'pass'};
  }
  // Compiler stages are distinct. A parse error masquerading as a type error
  // is not a valid type-system proof, even if its error text contains a word.
  if(vector.kind==='reject_parse' || vector.kind==='reject_typecheck') {
    const isParse=vector.kind==='reject_parse';
    const out=spawn(isParse?parseArgv:typecheckArgv,params);
    assertSourceIntact();
    check(out,out.exit!==0,isParse?'parser must reject invalid source':
      'typechecker must reject well-formed but ill-typed source');
    const diagnostic=vector.expect.diagnostic;
    if(!/^[a-z][a-z0-9_]*$/.test(diagnostic)) throw Error('invalid diagnostic class');
    const exactTag=new RegExp('(?:^|[^A-Za-z0-9_])'+diagnostic+'(?:$|[^A-Za-z0-9_])','m');
    if(!exactTag.test(out.stderr))
      throw Error('expected phase-specific compiler stderr diagnostic '+diagnostic+' absent');
    if(existsSync(artifact)) throw Error('rejected source published output artifact');
    return {...base,phase:isParse?'parser-reject':'typechecker-reject',
      compile_exit:out.exit,diagnostic_class:diagnostic,
      artifact_published:false,status:'pass'};
  }
  if(vector.kind==='accept_typecheck') {
    const checked=spawn(typecheckArgv,params);
    assertSourceIntact();
    check(checked,checked.exit===0,'typed compiler checker must accept source');
    let types; try { types=JSON.parse(checked.stdout); }
    catch { throw Error('typecheck mode must emit JSON on stdout'); }
    if(types?.result_type!==vector.expect.result_type)
      throw Error('inferred type mismatch: expected '+vector.expect.result_type);
    if(existsSync(artifact)) throw Error('typecheck-only stage published artifact');
    return {...base,phase:'typecheck',compile_exit:0,
      result_type:types.result_type,status:'pass'};
  }
  const out=spawn(compileArgv,params);
  assertSourceIntact();
  check(out,out.exit===0,'compiler must accept valid source');
  if(vector.kind!=='accept_execute') throw Error('unexpected vector kind: '+vector.kind);
  if(!existsSync(artifact)||!statSync(artifact).isFile()||statSync(artifact).size===0)
    throw Error('real compiler produced no nonempty guest artifact');
  const digest=sha256(readFileSync(artifact));
  const executed=spawn(runArgv,params);
  assertSourceIntact();
  check(executed,executed.exit===vector.expect.exit_code,
    'compiled guest exit does not match contract '+vector.expect.exit_code);
  if(!existsSync(artifact)||sha256(readFileSync(artifact))!==digest)
    throw Error('guest run mutated/removed the compiled artifact');
  let visitWitness;
  if(Array.isArray(vector.expect.visited)) {
    let witness; try { witness=JSON.parse(executed.stdout.trim()); }
    catch { throw Error('range visited-sequence witness must be guest JSON stdout'); }
    if(!Array.isArray(witness)||
       JSON.stringify(witness)!==JSON.stringify(vector.expect.visited))
      throw Error('range visit witness did not match declared sequence');
    visitWitness=witness;
  }
  return {...base,phase:'guest-execute',compile_exit:0,guest_exit:executed.exit,
    guest_stdout_sha256:sha256(executed.stdout),
    ...(visitWitness===undefined?{}:{visited:visitWitness}),
    artifact_sha256:digest,executed_guest:true,status:'pass'};
}
try {
  if(!validLanes.includes(lane)) throw Error('ATTO_VBR_LANE must name one supported guest lane');
  if(!/^\.[a-zA-Z0-9]{1,8}$/.test(ext)) throw Error('invalid artifact extension');
  if(manifest.schema!=='attolang.value-block-range.v0' ||
    manifest.status!=='PROPOSED_NOT_COMPILER_VERIFIED' ||
    !Array.isArray(manifest.cases)||manifest.cases.length<17)
    throw Error('wrong or incomplete canonical suite');
  const compile=requireArgv('ATTO_VBR_COMPILE_ARGV_JSON','{source}');
  if(!compile.some(x=>x.includes('{artifact}')))
    throw Error('compile command must write {artifact}; no host-evaluated fallback');
  const run=requireArgv('ATTO_VBR_RUN_ARGV_JSON','{artifact}');
  const lex=process.env.ATTO_VBR_LEX_ARGV_JSON ?
    requireArgv('ATTO_VBR_LEX_ARGV_JSON','{source}') : null;
  const typecheck=requireArgv('ATTO_VBR_TYPECHECK_ARGV_JSON','{source}');
  const parse=requireArgv('ATTO_VBR_PARSE_ARGV_JSON','{source}');
  const dir=mkdtempSync(join(tmpdir(),'atto-vbr-'));
  mkdirSync(dir,{recursive:true});
  for(const vector of manifest.cases) {
    try { observations.push(testCase(vector,compile,run,lex,typecheck,parse,dir)); }
    catch(error) { failures++; observations.push({
      id:vector.id,kind:vector.kind,status:'failed',detail:String(error.message).slice(0,1400),
      source_sha256:sha256(vector.source)
    }); }
  }
} catch(error) {
  failures++;
  observations.push({id:'configuration',status:'failed',detail:String(error.message).slice(0,1400)});
}
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',shell:false});
const head=(git.status===0 ? git.stdout.trim() : null);
const report={
  schema:'attolang.value-block-range.local-observations.v0',
  evidence_class:'UNVERIFIED_LOCAL_COMPILER_OBSERVATIONS',
  lane,repo_head_sha:validSha.test(head||'')?head:null,
  suite_sha256:sha256(readFileSync(manifestPath)),case_count:manifest.cases.length,
  passed:observations.filter(x=>x.status==='pass').length,
  certified_guest_passes:0,
  failed:failures,
  observations,
  warning:'Needs independent exact-head, source-blob, job/log, compiler artifact and guest execution validation before parity claim'
};
const reportPath=process.env.ATTO_VBR_REPORT_PATH;
if(reportPath) writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(failures) process.exitCode=1;
