import {createHash} from "node:crypto";
import {readFile,lstat} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const blob=b=>createHash("sha1").update("blob "+b.length+"\0").update(b).digest("hex");
export async function verifyAttoScalarV1(){
 const raw=await readFile(join(root,"contracts/atto-scalar-v1/cases.json"));
 if(blob(raw)!=="43c4d295a237e483f70722bd90ec10d273b73854")
   throw Error("unreviewed 19-case Atto scalar manifest");
 const c=JSON.parse(raw.toString("utf8"));
 if(raw.toString("utf8")!==JSON.stringify(c,null,2)+"\n"||
    c.schema!=="attolang.scalar-core.v1"||c.evidence_status!=="NOT_EXECUTED"||
    JSON.stringify(c.compiler_routes)!==JSON.stringify(["java","llvm","wasm","net","forge"])||
    !Array.isArray(c.cases)||c.cases.length!==19)
   throw Error("invalid Atto scalar corpus policy");
 const seen=new Set(),result=[];
 for(const item of c.cases){
   if(!/^[a-z0-9-]+$/.test(item.id)||seen.has(item.id)||
      !["positive","negative"].includes(item.kind)||
      item.path!==`contracts/atto-scalar-v1/${item.kind}/${item.id}.atto`)
     throw Error("invalid scalar case path or identity");
   seen.add(item.id);
   const path=join(root,item.path);
   const st=await lstat(path);
   if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>8192)
     throw Error("invalid scalar source file");
   const bytes=await readFile(path);
   if(blob(bytes)!==item.git_blob_sha1)throw Error("mutated scalar source "+item.id);
   result.push({...item,bytes});
 }
 if(result.filter(x=>x.kind==="positive").length!==10||
    result.filter(x=>x.kind==="negative").length!==9)
   throw Error("incomplete Atto scalar source polarity");
 return result;
}
