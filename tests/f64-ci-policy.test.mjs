import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const workflow=fileURLToPath(new URL("../.github/workflows/f64-exact-head-guest.yml",import.meta.url));
const content=readFileSync(workflow,"utf8");

test("PR-safe f64 lane cannot touch approved runner or credentials",()=>{
 const parts=content.split("\n  approved-real-guest:\n");
 assert.equal(parts.length,2,"real guest must be a distinct job");
 const [sourceOnly,real]=parts;
 assert.match(sourceOnly,/source-only-regression:/);
 assert.match(sourceOnly,/npm test/);
 assert.doesNotMatch(sourceOnly,/\$\{\{\s*secrets\./,"PR-side job must never access secrets");
 assert.doesNotMatch(sourceOnly,/self-hosted/,"PR job may use only source-org hosted worker");
 assert.match(real,/if: github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
 assert.match(real,/environment: atto-f64-guest-approval/);
 assert.match(real,/runs-on: \[self-hosted, linux, x64, atto-f64-approved\]/);
 assert.match(real,/ATTO_F64_APPROVED_RECEIPT_SHA256/);
 assert.match(real,/ATTO_F64_APPROVED_COMPILER_SHA256/);
 assert.doesNotMatch(real,/repository:\s*ores-truffle-oreslang\/oreslang-source\.llvm/,
   "never clone LLVM private source into the Wasm guest runner");
 assert.doesNotMatch(real,/secrets\.ORESLANG_LLVM_READ_TOKEN/,
   "never borrow cross-repository source access");
});

test("manual executable evidence may not become Java or release certification",()=>{
 assert.match(content,/f64-combined-executed\.json/);
 const admission=readFileSync(fileURLToPath(
   new URL("../scripts/f64-evidence-admission.mjs",import.meta.url)),"utf8");
 assert.match(admission,/javaComparison:"NOT_EXECUTED"/);
 assert.match(admission,/release:"NOT_CERTIFIED"/);
 assert.match(admission,/ctestJUnitSha256/);
 assert.match(admission,/negativeNoPublication/);
});
