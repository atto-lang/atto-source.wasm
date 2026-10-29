import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const SHA40=/^[0-9a-f]{40}$/;
const SHA256=/^[0-9a-f]{64}$/;
const repos=new Set([
  "ores-truffle-oreslang/oreslang-source.java",
  "ores-truffle-oreslang/oreslang-source.llvm",
  "ores-truffle-oreslang/oreslang-source.wasm",
  "ores-truffle-oreslang/oreslang-source.net",
  "ores-truffle-oreslang/oreslang-source.forge",
]);
export const fixtureType="oreslang-ci-public-synthetic-v1";
const keys=["artifactBytes","artifactSha256","fixtureType","schema","sourceHead","sourceRepo","sourceTree"];
export function publicPayload(repo,head,tree) {
  assert.ok(repos.has(repo),"unapproved source repository");
  assert.match(head,SHA40);assert.match(tree,SHA40);
  // No source files, package caches, private dependency bytes or credentials.
  return Buffer.from("ORESLANG_PUBLIC_CI_PROOF_V1\n"+repo+"\n"+head+"\n"+tree+"\n","utf8");
}
export function createEvidence(repo,head,tree,payload=publicPayload(repo,head,tree)) {
  return {schema:1,sourceRepo:repo,sourceHead:head,sourceTree:tree,
    fixtureType,artifactBytes:payload.byteLength,
    artifactSha256:createHash("sha256").update(payload).digest("hex")};
}
export function verifyEvidence(record,{repo,head,tree,payload}) {
  assert.ok(record&&typeof record==="object"&&!Array.isArray(record));
  assert.deepEqual(Object.keys(record).sort(),keys,"unexpected/missing provenance fields");
  assert.equal(record.schema,1);
  assert.ok(repos.has(repo),"unapproved source repository");
  assert.match(head,SHA40);assert.match(tree,SHA40);
  assert.equal(record.sourceRepo,repo,"source repository mismatch");
  assert.equal(record.sourceHead,head,"stale or changed commit");
  assert.equal(record.sourceTree,tree,"Git tree mismatch");
  assert.equal(record.fixtureType,fixtureType,"non-synthetic artifact forbidden");
  assert.ok(Buffer.isBuffer(payload));
  assert.deepEqual(payload,publicPayload(repo,head,tree),"unexpected source material in artifact");
  assert.equal(record.artifactBytes,payload.byteLength,"artifact length mismatch");
  assert.match(record.artifactSha256,SHA256);
  assert.equal(record.artifactSha256,
    createHash("sha256").update(payload).digest("hex"),"artifact checksum mismatch");
  return true;
}
function git(argument) {
  return execFileSync("git",["rev-parse",argument],{encoding:"utf8"}).trim();
}
export function runSourceFreeProof(expectedRepo,expectedHead) {
  assert.equal(process.env.GITHUB_REPOSITORY,expectedRepo,"wrong GitHub event repository");
  assert.ok(repos.has(expectedRepo),"unsupported repository");
  assert.match(expectedHead,SHA40);
  assert.equal(git("HEAD"),expectedHead,"checked-out commit differs from PR head");
  const tree=git("HEAD^{tree}");
  assert.match(tree,SHA40);
  for(const name of ["PRIVATE_CARGO_TOKEN","GIT_ASKPASS","GH_TOKEN",
      "CI_MIRROR_TOKEN","CARGO_REGISTRIES_CRATES_IO_TOKEN","NUGET_AUTH_TOKEN"]){
    assert.ok(!process.env[name],"source-free proof refuses credential-bearing environment: "+name);
  }
  const payload=publicPayload(expectedRepo,expectedHead,tree);
  const directory=mkdtempSync(join(process.env.RUNNER_TEMP||tmpdir(),"oreslang-public-proof-"));
  try{
    const path=join(directory,"synthetic.txt");
    writeFileSync(path,payload,{mode:0o600});
    const reread=readFileSync(path);
    const record=createEvidence(expectedRepo,expectedHead,tree,reread);
    verifyEvidence(record,{repo:expectedRepo,head:expectedHead,tree,payload:reread});
    assert.equal(git("HEAD"),expectedHead,"source HEAD changed during proof");
    assert.equal(git("HEAD^{tree}"),tree,"source Git tree changed during proof");
    process.stdout.write(JSON.stringify(record)+"\n");
  }finally{rmSync(directory,{recursive:true,force:true})}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert.equal(process.argv[2],"--verify","only source-free verification is supported");
  assert.equal(process.argv.length,5);
  runSourceFreeProof(process.argv[3],process.argv[4]);
}
