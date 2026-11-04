import {createHash} from "node:crypto";
import {open,lstat} from "node:fs/promises";
import {constants as fsConstants} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const blob=b=>createHash("sha1").update("blob "+b.length+"\0").update(b).digest("hex");

/**
 * Bounded fixture read through a checked source-owned path.
 * O_NOFOLLOW pins the leaf; checked ancestor components reject preexisting
 * directory symlinks. This is not a substitute for an immutable checkout if
 * a hostile process can concurrently replace ancestor directories.
 */
export async function readPinnedAttoScalarSource(rootDir,relative){
 if (typeof relative!=="string" ||
     !/^contracts\/atto-scalar-v1\/(?:cases\.json|(?:positive|negative)\/[a-z0-9-]+\.atto)$/.test(relative))
   throw Error("noncanonical scalar source path");
 // A caller-supplied root alias must not redirect the pinned corpus.
 const canonicalRoot=resolve(rootDir);
 const rootStat=await lstat(canonicalRoot);
 if(rootStat.isSymbolicLink()||!rootStat.isDirectory())
   throw Error("scalar fixture root is a symlink or non-directory");
 const parts=relative.split("/");
 let path=canonicalRoot;
 for(let i=0;i<parts.length;i++){
   path=join(path,parts[i]);
   const st=await lstat(path);
   if(st.isSymbolicLink() || (i<parts.length-1 ? !st.isDirectory():!st.isFile()))
     throw Error("scalar source contains symlink or nonregular path");
 }
 // O_NONBLOCK prevents a FIFO swapped in after lstat from hanging open().
 if(!Number.isInteger(fsConstants.O_NOFOLLOW)||!Number.isInteger(fsConstants.O_NONBLOCK))
   throw Error("secure scalar file descriptors are unsupported");
 const fh=await open(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);
 try {
   const st=await fh.stat();
   if(!st.isFile()||!Number.isSafeInteger(st.size)||st.size<1||st.size>8192)
     throw Error("scalar fixture exceeds byte budget or is not regular");
   // Never use readFile(): a concurrent append can defeat a pre-read size check.
   const bytes=Buffer.alloc(st.size);
   let at=0;
   while(at<bytes.length){
     const {bytesRead}=await fh.read(bytes,at,bytes.length-at,at);
     if(bytesRead===0)throw Error("scalar source changed during bounded read");
     at+=bytesRead;
   }
   const extra=Buffer.alloc(1);
   if((await fh.read(extra,0,1,bytes.length)).bytesRead!==0)
     throw Error("scalar source changed during bounded read");
   const after=await fh.stat();
   if(!after.isFile()||after.size!==st.size||
      after.dev!==st.dev||after.ino!==st.ino||
      after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)
     throw Error("scalar source changed during bounded read");
   return bytes;
 }finally{await fh.close();}
}

export async function verifyAttoScalarV1(){
 const raw=await readPinnedAttoScalarSource(root,"contracts/atto-scalar-v1/cases.json");
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
   const bytes=await readPinnedAttoScalarSource(root,item.path);
   if(blob(bytes)!==item.git_blob_sha1)throw Error("mutated scalar source "+item.id);
   result.push({...item,bytes});
 }
 if(result.filter(x=>x.kind==="positive").length!==10||
    result.filter(x=>x.kind==="negative").length!==9)
   throw Error("incomplete Atto scalar source polarity");
 return result;
}
