// Host-side provenance and schema validator for the portable scalar source
// corpus. No parser/host result here counts as an executed Oreslang guest.
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";

export const PORTABLE_SCALAR_BLOB="001e8894cbeb87509878a4de36263a1a327805b1";
const fixture=new URL("../contracts/parity/portable-scalar-v1-20261101.json",import.meta.url);
const maxPositive=1n<<63n;
const minNegative=-(1n<<63n);

export function gitBlobSha(bytes){
  const header=Buffer.from("blob "+bytes.length+"\0","ascii");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}
export function verifyPortableScalarCorpusBytes(bytes,{expectedBlob=PORTABLE_SCALAR_BLOB}={}){
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>16384)
    throw Error("portable scalar manifest must be bounded nonempty bytes");
  if(gitBlobSha(bytes)!==expectedBlob)
    throw Error("portable scalar manifest Git blob differs from reviewed corpus");
  const decoded=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  const doc=JSON.parse(decoded);
  if(doc.schema_version!=="2026-11-01.scalar-v1"||doc.scope!=="import-free-pure-i64")
    throw Error("portable scalar schema/scope drift");
  if(!Array.isArray(doc.positive)||!Array.isArray(doc.negative)||
     doc.positive.length!==16||doc.negative.length!==6)
    throw Error("portable scalar fixture inventory incomplete");
  const ids=new Set(), expressions=new Set();
  const positiveGrammar=/^[0-9_()+* -]{1,128}$/;
  const negativeGrammar=/^[0-9_()+*%/^ -]{1,128}$/;
  for(const [kind,items] of [["positive",doc.positive],["negative",doc.negative]]){
    for(const row of items){
      if(!row||typeof row!=="object"||Array.isArray(row)||
         typeof row.id!=="string"||!(/^[a-z][a-z0-9-]{1,79}$/).test(row.id)||
         ids.has(row.id))throw Error("portable scalar unsafe or duplicate case identity");
      ids.add(row.id);
      if(typeof row.expression!=="string"||
         !(kind==="positive"?positiveGrammar:negativeGrammar).test(row.expression)||
         expressions.has(row.expression))
        throw Error("portable scalar unsafe or duplicate expression");
      expressions.add(row.expression);
      if(kind==="positive"){
        if(typeof row.expected!=="string"||row.expected==="-0"||!(/^-?(?:0|[1-9][0-9]*)$/).test(row.expected))
          throw Error("portable scalar malformed expected i64");
        const value=BigInt(row.expected);
        if(value<minNegative||value>=maxPositive)
          throw Error("portable scalar expected result outside signed i64");
      }else{
        if(typeof row.reason!=="string"||
          !["removed-operator","unsupported-int-division","literal-out-of-range"].includes(row.reason))
          throw Error("portable scalar unsupported negative diagnostic class");
        if(row.reason==="removed-operator"&&!/[%^]/.test(row.expression))
          throw Error("portable scalar removed operator control is not an operator");
        if(row.reason==="unsupported-int-division"&&!row.expression.includes("/"))
          throw Error("portable scalar division control lacks division");
        if(row.reason==="literal-out-of-range"){
          if(!/^-?[0-9][0-9_]*$/.test(row.expression)||
             !(BigInt(row.expression.replaceAll("_",""))<minNegative||
               BigInt(row.expression.replaceAll("_",""))>=maxPositive))
            throw Error("portable scalar out-of-range control is not out of range");
        }
      }
    }
  }
  return doc;
}
export async function loadPortableScalarCorpus(){
  return verifyPortableScalarCorpusBytes(await readFile(fixture));
}
