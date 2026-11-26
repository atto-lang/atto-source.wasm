import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const verifier = fileURLToPath(new URL('../scripts/verify-trap-result-wasm.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/trap-result-v1/result-existing.atto', import.meta.url));
const sha256 = b => createHash('sha256').update(b).digest('hex');
const gitBlob = b => createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const sourceBytes = readFileSync(fixture);
const pinnedSourceBlob = '2d71c15eb4e2f9f5b9bf42b5eef8ce3271d8106e';

function badInvocation(args) {
  const result = spawnSync(process.execPath, [verifier, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'missing or forged real compiler must fail closed');
  return result.stdout + '\n' + result.stderr;
}

function withSource(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'atto-result-gate-'));
  try {
    const source = join(directory, 'main.atto');
    const compiler = join(directory, 'compiler.wasm');
    const emptyWasm = Buffer.from([0,97,115,109,1,0,0,0]);
    writeFileSync(source, sourceBytes);
    writeFileSync(compiler, emptyWasm);
    return fn({source, compiler, emptyWasm});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('canonical Result fixture is exact Git blob from shared conformance', () => {
  assert.equal(gitBlob(sourceBytes), pinnedSourceBlob);
  assert.match(sourceBytes.toString('utf8'), /Result<int, Error> = trap ok\(\)/);
  assert.doesNotMatch(sourceBytes.toString('utf8'), /Option<Result|on Some|on None/);
});

test('real compiler gate never silently skips missing inputs', () => {
  assert.match(badInvocation([]), /Usage: .*result.atto/);
  assert.match(badInvocation(['/missing/wasm','/missing/atto','0'.repeat(64),'bad']),
    /Usage:/);
});

test('mismatched compiler digest fails before Wasm instantiation', () => {
  withSource(({source,compiler}) => {
    assert.match(badInvocation([compiler,source,'0'.repeat(64),pinnedSourceBlob]),
      /unreviewed compiler digest/);
  });
});

test('mismatched source blob fails before compiling guest', () => {
  withSource(({source,compiler,emptyWasm}) => {
    assert.match(badInvocation([compiler,source,sha256(emptyWasm),'0'.repeat(40)]),
      /reviewed Result fixture blob/);
  });
});

test('a valid hash is not a trusted compiler or executable conformance', () => {
  withSource(({source,compiler,emptyWasm}) => {
    assert.match(badInvocation([compiler,source,sha256(emptyWasm),pinnedSourceBlob]),
      /abi_version is not a function/);
  });
});

test('legacy Option trap source cannot impersonate the pinned Result fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atto-option-obsolete-'));
  try {
    const compiler = join(dir, 'compiler.wasm');
    const source = join(dir, 'old.atto');
    const emptyWasm = Buffer.from([0,97,115,109,1,0,0,0]);
    writeFileSync(compiler,emptyWasm);
    writeFileSync(source,'pub fnc main(): int { val v: Option<int> = trap 42; return 42; }\n');
    assert.match(badInvocation([compiler,source,sha256(emptyWasm),pinnedSourceBlob]),
      /reviewed Result fixture blob/);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
