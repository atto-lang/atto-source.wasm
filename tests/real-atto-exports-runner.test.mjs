import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/verify-real-atto-declarative-exports.mjs', import.meta.url));
function invoke(variables = {}) {
  const env = {...process.env};
  delete env.ATTOC_PATH;
  delete env.ATTOC_SHA256;
  Object.assign(env, variables);
  return spawnSync(process.execPath, [script], {
    encoding:'utf8', timeout:5000, maxBuffer:256*1024, env
  });
}
function assertDenied(result, diagnostic) {
  assert.equal(result.status, 1, 'missing/untrusted compiler must not be marked passed');
  assert.equal(result.stdout, '', 'untrusted compiler must not emit a success receipt');
  assert.match(result.stderr, diagnostic);
}

test('real export-contract runner fails closed without a compiler', () => {
  assertDenied(invoke(), /ATTOC_PATH must be an absolute path/);
});

test('real export-contract runner requires a pinned lowercase SHA-256', () => {
  assertDenied(invoke({ATTOC_PATH:process.execPath}), /ATTOC_SHA256 must be/);
  assertDenied(invoke({ATTOC_PATH:process.execPath,ATTOC_SHA256:'0'.repeat(63)}),
    /ATTOC_SHA256 must be/);
});

test('real export-contract runner rejects an untrusted compiler before execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atto-bad-compiler-'));
  try {
    const fakeCompiler = join(dir, 'not-attoc');
    writeFileSync(fakeCompiler, '#!/bin/sh\necho fake\n', {mode:0o700});
    const result = invoke({ATTOC_PATH:fakeCompiler,ATTOC_SHA256:'0'.repeat(64)});
    assertDenied(result, /ATTOC_COMPILER_SHA256_MISMATCH/);
  } finally {
    rmSync(dir, {recursive:true,force:true});
  }
});
