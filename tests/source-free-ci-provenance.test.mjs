import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {createEvidence,publicPayload,verifyEvidence} from "../scripts/source-free-ci-provenance.mjs";
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
