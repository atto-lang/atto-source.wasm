#!/usr/bin/env node
// Real Rust attoc package graph -> verified wasm32 guest. No source parser or
// linker is reimplemented here. This test accepts only a reviewed exact compiler.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync,
  existsSync, realpathSync, statSync, symlinkSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {fixed_memory_pages} from '../src/wasm-profile.mjs';

const [compilerArg, compilerDigest] = process.argv.slice(2);
if (process.argv.length !== 4 || !isAbsolute(compilerArg ?? '') ||
    !/^[a-f0-9]{64}$/.test(compilerDigest ?? '')) {
  throw Error('Usage: node scripts/verify-linked-package-wasm.mjs /absolute/reviewed/attoc <compiler_sha256_64hex>');
}
const sha256 = b => createHash('sha256').update(b).digest('hex');
const blobSha = b => createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const compiler = realpathSync(compilerArg);
assert.ok(statSync(compiler).isFile(), 'compiler must be a regular file');
assert.equal(sha256(readFileSync(compiler)), compilerDigest, 'compiler binary SHA-256 mismatch');
const root = fileURLToPath(new URL('../tests/fixtures/linked-package-v1/', import.meta.url));
const fixtures = Object.freeze([
  ['.atto.pkg.toml', '4177f0f46272526a45fb9db775efa71814f4657b'],
  ['src/main.atto', '22d252e703502488407c948f0f3f84cc1d91d36a'],
  ['lib/orders.atto', '868403fab2f8d3524bf0cf54799bca6d80e89b43'],
  ['lib/math.atto', '525585c4eb34a4572b7041cf72d658c66fd045cc']
]);
const source = new Map();
for (const [path, sha] of fixtures) {
  const data = readFileSync(join(root, path));
  assert.equal(blobSha(data), sha, 'unreviewed linked-package source: ' + path);
  source.set(path, data);
}

const temp = mkdtempSync(join(tmpdir(), 'atto-real-wasm-package-'));
const external = mkdtempSync(join(tmpdir(), 'atto-real-wasm-outside-'));
const receipts = [];
function build(id, edit) {
  const project = join(temp, id);
  for (const [path, bytes] of source) {
    const target = join(project, path);
    mkdirSync(resolve(target, '..'), {recursive: true});
    writeFileSync(target, bytes, {flag: 'wx'});
  }
  if (edit) edit(project);
  const output = join(project, 'guest.wasm');
  const invocation = spawnSync(compiler,
    ['--package-root', project, '--entry', 'src/main.atto', '-o', output], {
      cwd: project, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}
    });
  assert.equal(invocation.error, undefined, id + ' failed to spawn reviewed compiler');
  assert.equal(invocation.signal, null, id + ' compiler killed/crashed');
  return {invocation, output};
}
function reject(id, edit, code) {
  const {invocation, output} = build(id, edit);
  assert.equal(invocation.status, 1, id + ' must be a compiler rejection');
  assert.match(invocation.stderr, new RegExp(code), id + ' wrong compiler diagnostic');
  assert.equal(existsSync(output), false, id + ' published Wasm after rejection');
  receipts.push({id, result: 'compile-reject-no-artifact'});
}
try {
  const {invocation, output} = build('good');
  assert.equal(invocation.status, 0, invocation.stderr);
  const size = statSync(output).size;
  assert.ok(size > 8 && size <= 1024 * 1024, 'bounded real guest bytes');
  const bytes = readFileSync(output);
  assert.ok(WebAssembly.validate(bytes), 'compiler emitted invalid wasm32');
  const pages=fixed_memory_pages(bytes); // 0 is valid for scalar-only guests.
  assert.ok(pages>=0,'invalid memory layout');
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [], 'linked guest must have zero host imports');
  const exports = WebAssembly.Module.exports(module);
  const memoryExports=exports.filter(x=>x.kind==='memory');
  assert.equal(memoryExports.length,pages===0?0:1,'memory export must match fixed memory layout');
  assert.ok(exports.some(x=>x.name==='main'&&x.kind==='function'),'entry must be a function');
  assert.ok(exports.some(x=>x.name==='panic_code'&&x.kind==='global'),'panic code must be a global');
  const names = WebAssembly.Module.exports(module).map(x => x.name);
  assert.ok(names.includes('main') && names.includes('panic_code'));
  assert.ok(names.every(x => ['main','panic_code','memory'].includes(x)), 'unknown guest authority');
  const guest = new WebAssembly.Instance(module, {});
  assert.equal(guest.exports.main(), 42n, 'three-file linked guest must return 42');
  assert.equal(guest.exports.panic_code.value, 0, 'guest must not panic');
  receipts.push({id:'three-file-source-linked', result:'guest-executed', guest_sha256:sha256(bytes)});

  reject('private-member', project => {
    const path=join(project,'lib/orders.atto');
    writeFileSync(path,readFileSync(path,'utf8').replace('Math.double(x)','Math.secret()'));
  }, 'E_PRIVATE');

  reject('missing-transitive-dependency', project => {
    rmSync(join(project,'lib/math.atto'));
  }, 'E_UNBOUND|E_IMPORT');

  reject('parent-traversal', project => {
    const path=join(project,'lib/orders.atto');
    writeFileSync(path,readFileSync(path,'utf8').replace('./math.atto','./../math.atto'));
  }, 'E_IMPORT_PATH');

  reject('transitive-cycle', project => {
    const path=join(project,'lib/math.atto');
    writeFileSync(path,readFileSync(path,'utf8').replace('use namespace maths;\n',
      'use namespace maths;\nimport module Orders from "./orders.atto";\n'));
  }, 'E_IMPORT_CYCLE');

  reject('symlink-outside-package', project => {
    const outside=join(external,'math.atto');
    writeFileSync(outside,source.get('lib/math.atto'));
    const link=join(project,'lib/math.atto');
    rmSync(link);
    symlinkSync(outside,link);
  }, 'E_IMPORT|E_IMPORT_PATH');

  assert.equal(sha256(readFileSync(compiler)), compilerDigest,
    'compiler changed while compiling source graph');
  console.log(JSON.stringify({
    status:'PASS', profile:'atto-rust-linked-package-wasm32-v1',
    evidence_kind:'actual-rust-compiler-wasm32-guest',
    compiler_sha256:compilerDigest,
    source_git_blobs:Object.fromEntries(fixtures),
    cases:receipts
  }));
} finally {
  rmSync(temp,{recursive:true,force:true});
  rmSync(external,{recursive:true,force:true});
}
