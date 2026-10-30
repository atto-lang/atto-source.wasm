import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const SHA40=/^[0-9a-f]{40}$/;
const SHA256=/^[0-9a-f]{64}$/;
const repoIds=new Map([
  ["ores-truffle-oreslang/oreslang-source.java",1400792274],
  ["ores-truffle-oreslang/oreslang-source.llvm",1410897874],
  ["ores-truffle-oreslang/oreslang-source.wasm",1419858954],
  ["ores-truffle-oreslang/oreslang-source.net",1419704375],
  ["ores-truffle-oreslang/oreslang-source.forge",1419703674],
]);
const repos=new Set(repoIds.keys());
export const fixtureType="oreslang-ci-public-synthetic-v2";
const keys=["artifactBytes","artifactSha256","fixtureType","schema","sourceHead","sourceRepo","sourceRepoId","sourceTree"];
export function publicPayload(repo,head,tree) {
  assert.ok(repos.has(repo),"unapproved source repository");
  assert.match(head,SHA40);assert.match(tree,SHA40);
  // No source files, package caches, private dependency bytes or credentials.
  return Buffer.from("ORESLANG_PUBLIC_CI_PROOF_V2\n"+repo+"\n"+repoIds.get(repo)+"\n"+head+"\n"+tree+"\n","utf8");
}
export function createEvidence(repo,head,tree,payload=publicPayload(repo,head,tree)) {
  return {schema:2,sourceRepo:repo,sourceRepoId:repoIds.get(repo),sourceHead:head,sourceTree:tree,
    fixtureType,artifactBytes:payload.byteLength,
    artifactSha256:createHash("sha256").update(payload).digest("hex")};
}
export function verifyEvidence(record,{repo,head,tree,payload}) {
  assert.ok(record&&typeof record==="object"&&!Array.isArray(record));
  assert.deepEqual(Object.keys(record).sort(),keys,"unexpected/missing provenance fields");
  assert.equal(record.schema,2);
  assert.ok(repos.has(repo),"unapproved source repository");
  assert.match(head,SHA40);assert.match(tree,SHA40);
  assert.equal(record.sourceRepo,repo,"source repository mismatch");
  assert.equal(record.sourceRepoId,repoIds.get(repo),"numeric GitHub repository identity mismatch");
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
export function assertCleanGitStatus(status) {
  assert.equal(status,"","source checkout is dirty (tracked, staged or untracked files)");
}
function gitStatus() {
  return execFileSync("git",["status","--porcelain=v1","--untracked-files=all"],{encoding:"utf8"});
}
export function runSourceFreeProof(expectedRepo,expectedHead) {
  assert.equal(process.env.GITHUB_REPOSITORY,expectedRepo,"wrong GitHub event repository");
  assert.ok(repos.has(expectedRepo),"unsupported repository");
  assert.equal(process.env.GITHUB_REPOSITORY_ID,String(repoIds.get(expectedRepo)),
    "numeric GitHub repository identity mismatch");
  assert.ok(process.env.GITHUB_WORKSPACE,"GitHub workspace identity required");
  assert.equal(realpathSync(process.cwd()),realpathSync(process.env.GITHUB_WORKSPACE),
    "source proof must execute at GitHub checkout root");
  assert.match(expectedHead,SHA40);
  assert.equal(git("HEAD"),expectedHead,"checked-out commit differs from PR head");
  const tree=git("HEAD^{tree}");
  assert.match(tree,SHA40);
  assertCleanGitStatus(gitStatus());
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
    assertCleanGitStatus(gitStatus());
    process.stdout.write(JSON.stringify(record)+"\n");
  }finally{rmSync(directory,{recursive:true,force:true})}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert.equal(process.argv[2],"--verify","only source-free verification is supported");
  assert.equal(process.argv.length,5);
  runSourceFreeProof(process.argv[3],process.argv[4]);
}
