import {mkdtempSync,writeFileSync,rmSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

const compilerArg=process.argv.find(x=>x.startsWith("--compiler="));
if(!compilerArg)throw new Error("usage: node tests/refinement-admission-delegated.mjs --compiler=/absolute/oreslang-llvmc");
const compiler=realpathSync(compilerArg.slice("--compiler=".length));
const control="fnc main(): int { return 42; }\n";
const unsupported={
  annotation:"@Size(min=1,max=32)\ntype Username = string;\nfnc main(): int { return 42; }\n",
  with:"type NonEmpty = string with length gt 0;\nfnc main(): int { return 42; }\n",
  where:"type NonBlank = string where it.trim().length > 0;\nfnc main(): int { return 42; }\n",
  newtype:"define newtype Username(string) with length gte 1;\nfnc main(): int { return 42; }\n",
  "port-keyword":"type Port = int with value gte 1 and value lte 65535;\nfnc main(): int { return 42; }\n",
  "port-symbol":"type Port = int with value >= 1 and value <= 65535;\nfnc main(): int { return 42; }\n",
  "percentage-keyword":"type Percentage = int with value gte 0 and value lte 100;\nfnc main(): int { return 42; }\n",
  "percentage-symbol":"type Percentage = int with value >= 0 and value <= 100;\nfnc main(): int { return 42; }\n",
  "legacy-ge":"type Legacy = int with value ge 1;\nfnc main(): int { return 42; }\n",
  "legacy-le":"type Legacy = int with value le 10;\nfnc main(): int { return 42; }\n",
  "invalid-with":"type T = string with length gt 0 or length eq 10;\nfnc main(): int { return 42; }\n"
};
const run=source=>{
  const result=spawnSync(compiler,[source],{encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,windowsHide:true});
  if(result.error)throw result.error;
  return result;
};
const root=mkdtempSync(join(tmpdir(),"ores-wasm-refinement-"));
try{
  const scalar=join(root,"control.ores");writeFileSync(scalar,control,{encoding:"utf8",flag:"wx"});
  const ok=run(scalar);
  if(ok.status!==0||ok.signal||!ok.stdout.includes("define"))
    throw new Error("real LLVM compiler positive control failed");
  for(const [name,source] of Object.entries(unsupported)){
    const path=join(root,name+".ores");writeFileSync(path,source,{encoding:"utf8",flag:"wx"});
    const result=run(path);
    if(result.status===0&&!result.signal)throw new Error(name+": unsupported refinement compiled");
    if(result.stdout.trim())throw new Error(name+": rejection leaked partial LLVM IR");
    if(!result.stderr.trim())throw new Error(name+": rejection had no diagnostic");
  }
  console.log("PASS delegated LLVM refinement admission: 11 negatives + scalar control; no Wasm runtime parity claimed");
}finally{rmSync(root,{recursive:true,force:true})}
