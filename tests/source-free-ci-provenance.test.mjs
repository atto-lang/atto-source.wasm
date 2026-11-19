import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {assertCleanGitStatus,createEvidence,gitStatus,publicPayload,verifyEvidence} from "../scripts/source-free-ci-provenance.mjs";
const repo="ores-truffle-oreslang/oreslang-source.llvm";
const head="a".repeat(40),tree="b".repeat(40);
const payload=publicPayload(repo,head,tree);
const record=()=>createEvidence(repo,head,tree);
const check=r=>verifyEvidence(r,{repo,head,tree,payload});
test("accepts exact synthetic proof with pinned head/tree and checksum",()=>{
  assert.equal(check(record()),true);
});
for(const [name,change] of [
  ["wrong repository",r=>r.sourceRepo="other/private-repo"],
  ["numeric repository ID substitution",r=>r.sourceRepoId=999999999],
  ["stale commit",r=>r.sourceHead="c".repeat(40)],
  ["altered tree",r=>r.sourceTree="c".repeat(40)],
  ["forged digest",r=>r.artifactSha256="0".repeat(64)],
  ["truncated artifact",r=>r.artifactBytes--],
  ["unknown artifact",r=>r.fixtureType="private-source"],
  ["schema downgrade",r=>r.schema=0],
  ["extra authority claim",r=>r.privateExportApproved=true],
  ["missing checksum",r=>delete r.artifactSha256],
]){
  test("rejects "+name,()=>{
    const r=record();change(r);assert.throws(()=>check(r));
  });
}
test("rejects modified artifact contents even when digest is recomputed",()=>{
  const altered=Buffer.from("PRIVATE SOURCE REPLACEMENT");
  const evidence=createEvidence(repo,head,tree,altered);
  assert.throws(()=>verifyEvidence(evidence,{repo,head,tree,payload:altered}),/unexpected source material/);
});
test("rejects unexpected repository and malformed SHA",()=>{
  assert.throws(()=>publicPayload("other/private-repo",head,tree));
  assert.throws(()=>publicPayload(repo,"main",tree));
});
test("matching workflow enforces source-only read-only verified checkout",()=>{
  const w=readFileSync(new URL("../.github/workflows/source-free-ci-provenance.yml",import.meta.url),"utf8");
  assert.match(w,/pull_request:/);
  assert.match(w,/permissions:\s*\n\s+contents: read/);
  assert.match(w,/persist-credentials: false/);
  assert.match(w,/submodules: false/);
  assert.ok(w.includes("github.event.pull_request.head.sha || github.sha"));
  assert.ok(w.includes("scripts/source-free-ci-provenance.mjs"));
  assert.ok(w.includes("node --test tests/source-free-ci-provenance.test.mjs"));
  assert.doesNotMatch(w,/pull_request_target:|secrets\.|contents: write|packages: write|id-token: write/);
  assert.doesNotMatch(w,/repository:\s*(?:[^\n]+\/)+[^\n]+/);
});

test("rejects tracked, staged, and untracked source checkout contamination",()=>{
  assert.doesNotThrow(()=>assertCleanGitStatus(""));
  for(const dirty of [" M scripts/proof.mjs\n","M  tests/proof.mjs\n","?? injected.mjs\n",
      "A  staged-secret.txt\n"," D tracked-file\n"])
    assert.throws(()=>assertCleanGitStatus(dirty),/source checkout is dirty/);
});
test("workflow explicitly resets checkout to exact commit and never preserves credentials",()=>{
  const w=readFileSync(new URL("../.github/workflows/source-free-ci-provenance.yml",import.meta.url),"utf8");
  assert.match(w,/fetch-depth: 1/);
  assert.match(w,/clean: true/);
  assert.match(w,/actions\/checkout@[0-9a-f]{40}/);
  assert.match(w,/actions\/setup-node@[0-9a-f]{40}/);
});

test("actual git checkout admission rejects staged, modified, untracked and ignored files",()=>{
  const cwd=mkdtempSync(join(tmpdir(),"oreslang-ci-clean-"));
  const git=(...args)=>execFileSync("git",args,{cwd,encoding:"utf8",timeout:10000});
  try {
    git("init","-q");
    writeFileSync(join(cwd,"tracked.txt"),"baseline\n");
    writeFileSync(join(cwd,".gitignore"),"ignored.txt\n");
    git("add","tracked.txt",".gitignore");
    git("-c","user.name=CI Canary","-c","user.email=ci@example.invalid","commit","-qm","synthetic baseline");
    assertCleanGitStatus(gitStatus(cwd));
    writeFileSync(join(cwd,"tracked.txt"),"changed\n");
    assert.throws(()=>assertCleanGitStatus(gitStatus(cwd)),/dirty/);
    git("add","tracked.txt");
    assert.throws(()=>assertCleanGitStatus(gitStatus(cwd)),/dirty/);
    git("reset","-q","--hard","HEAD");
    writeFileSync(join(cwd,"untracked.txt"),"injected\n");
    assert.throws(()=>assertCleanGitStatus(gitStatus(cwd)),/dirty/);
    rmSync(join(cwd,"untracked.txt"));
    writeFileSync(join(cwd,"ignored.txt"),"injected but ignored\n");
    const status=gitStatus(cwd);
    assert.match(status,/!! ignored\.txt/);
    assert.throws(()=>assertCleanGitStatus(status),/dirty/);
  }finally{rmSync(cwd,{recursive:true,force:true})}
});
