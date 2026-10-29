import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const script=fileURLToPath(new URL('../scripts/build-pinned-llvm-compiler.sh',import.meta.url));
const content=readFileSync(script,'utf8');
const sourcePin='a79156b74098c368763ee2c6843a65126e3051bf';
const treePin='43f8bda51bae2deb7747d73962be3ef6a3534628';

test('LLVM compiler build is fixed to independently reviewed commit and tree',()=>{
  assert.match(content,/PINNED_LLVM_SOURCE_COMMIT=a79156b74098c368763ee2c6843a65126e3051bf/);
  assert.match(content,/PINNED_LLVM_SOURCE_TREE=43f8bda51bae2deb7747d73962be3ef6a3534628/);
  assert.ok(content.includes('git -C "$source_dir" rev-parse HEAD'));
  assert.ok(content.includes("git -C \"$source_dir\" rev-parse 'HEAD^{tree}'"));
  assert.ok(content.includes('git -C "$source_dir" status --porcelain --untracked-files=no'));
  assert.ok(content.includes('--target oreslang-llvmc --parallel 2'));
  assert.ok(content.includes("mode=\"\${1:-build}\""));
  assert.ok(content.includes('mode" == --preflight'));
  assert.ok(content.includes('refusing preexisting build directory or symbolic link'));
  assert.ok(content.includes('LLVM tracked source status query failed'));
  assert.ok(content.includes('LLVM untracked-file audit failed'));
  assert.ok(content.includes('LLVM ignored-file audit failed'));
  assert.ok(content.includes('verify_compiler_receipt.py" capture'));
  assert.ok(content.includes('verify_compiler_receipt.py" verify'));
  assert.ok(content.includes('ORESLANG_LLVM_COMPILER_RECEIPT='));
  assert.equal(sourcePin.length,40);
  assert.equal(treePin.length,40);
});
test('compiler build script cannot fetch private source or use cross-repository credentials',()=>{
  assert.doesNotMatch(content,/(?:git|gh)\s+(?:clone|fetch)|curl\s|wget\s|GITHUB_TOKEN|secrets\.|private.*token/i);
  const syntax=spawnSync('bash',['-n',script],{encoding:'utf8',timeout:3000});
  assert.equal(syntax.status,0,syntax.stderr);
});
test('missing authorized checkout fails before any compiler build',()=>{
  const r=spawnSync('bash',[script],{
    cwd:resolve(fileURLToPath(new URL('..',import.meta.url))),
    encoding:'utf8',timeout:3000,
    env:{PATH:process.env.PATH||'/usr/bin:/bin',RUNNER_TEMP:'/tmp'}
  });
  assert.equal(r.status,1);
  assert.match(r.stderr,/NOT_EXECUTED: pinned LLVM build: authorized absolute/);
});
