import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const verifier = fileURLToPath(new URL('./verify-trap-wasm.mjs', import.meta.url));
const sha256 = x => createHash('sha256').update(x).digest('hex');
const gitBlob = x => createHash('sha1').update('blob ' + x.length + '\0').update(x).digest('hex');

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'atto-trap-verifier-'));
  try {
    const compiler = join(dir, 'compiler.wasm');
    const source = join(dir, 'trap.atto');
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]); // valid empty Wasm: NO ABI v2
    const atto = Buffer.from('pub fnc main(): int { return 7; }\n');
    writeFileSync(compiler, wasm);
    writeFileSync(source, atto);
    return fn({compiler, source, wasm, atto});
  } finally {
    rmSync(dir, {recursive:true, force:true});
  }
}

function invoke(args) {
  const r = spawnSync(process.execPath, [verifier, ...args], {
    encoding:'utf8', timeout:10_000, maxBuffer:1024*1024,
  });
  assert.equal(r.error, undefined, 'verifier invocation must complete in time');
  assert.notEqual(r.status, 0, 'invalid proof must never pass');
  return r.stderr + '\n' + r.stdout;
}

test('missing artifact and hash arguments fail closed', () => {
  assert.match(invoke([]), /Usage: .*compiler_sha256.*sample_git_blob_sha1/);
});

test('malformed compiler digest and source Git blob fail before artifact use', () => {
  withFixture(({compiler,source,wasm,atto}) => {
    assert.match(invoke([compiler,source,'not-a-hash',gitBlob(atto)]), /Usage:/);
    assert.match(invoke([compiler,source,sha256(wasm),'not-a-blob']), /Usage:/);
  });
});

test('tampered compiler bytes cannot pass a pinned digest', () => {
  withFixture(({compiler,source,atto}) => {
    assert.match(invoke([compiler,source,'0'.repeat(64),gitBlob(atto)]),
      /unreviewed compiler digest/);
  });
});

test('changed public example cannot pass the reviewed Git blob SHA', () => {
  withFixture(({compiler,source,wasm}) => {
    assert.match(invoke([compiler,source,sha256(wasm),'0'.repeat(40)]),
      /sample does not match reviewed playground blob/);
  });
});

test('matching hashes alone cannot authorize a compiler with no ABI', () => {
  withFixture(({compiler,source,wasm,atto}) => {
    assert.match(invoke([compiler,source,sha256(wasm),gitBlob(atto)]),
      /abi_version is not a function/);
  });
});
