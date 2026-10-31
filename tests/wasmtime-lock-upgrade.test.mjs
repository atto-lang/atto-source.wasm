import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, linkSync, symlinkSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';

// Source-free, hermetic unit tests of the transactional lockfile updater.
// Cargo is deliberately mocked; these tests are NOT Rust dependency resolution,
// package authenticity, guest execution, or native Wasmtime security evidence.
const scriptSource = resolve(process.env.ORE_WASMTIME_UPGRADE_SCRIPT ??
  fileURLToPath(new URL('../scripts/upgrade-wasmtime-49-0-4-locks.sh', import.meta.url)));
const oldPre = `version = 4\n\n[[package]]\nname = "wasmtime"\nversion = "49.0.3"\n\n[[package]]\nname = "cranelift-codegen"\nversion = "0.136.3"\n`;
const oldRun = `version = 4\n\n[[package]]\nname = "wasmtime"\nversion = "49.0.3"\n`;
const newPre = `version = 4\n\n[[package]]\nname = "wasmtime"\nversion = "49.0.4"\n\n[[package]]\nname = "pulley-interpreter"\nversion = "49.0.4"\n\n[[package]]\nname = "wasmtime-internal-cranelift"\nversion = "49.0.4"\n\n[[package]]\nname = "cranelift-codegen"\nversion = "0.136.4"\n`;
const newRun = `version = 4\n\n[[package]]\nname = "wasmtime"\nversion = "49.0.4"\n\n[[package]]\nname = "wasmtime-environ"\nversion = "49.0.4"\n`;
const mockCargo = `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
update)
  if [[ " $* " == *" aot-host/precompile/Cargo.toml "* ]]; then
    printf '%s' "$MOCK_NEW_PRE" > aot-host/precompile/Cargo.lock
  elif [[ " $* " == *" aot-host/run/Cargo.toml "* ]]; then
    if [[ "\${MOCK_FAIL_RUNNER:-}" == yes ]]; then exit 89; fi
    printf '%s' "$MOCK_NEW_RUN" > aot-host/run/Cargo.lock
    if [[ "\${MOCK_OLD_TRANSITIVE:-}" == yes ]]; then
      printf '\\n[[package]]\\nname = "wasmtime-internal-core"\\nversion = "49.0.3"\\n' >> aot-host/run/Cargo.lock
    fi
    if [[ "\${MOCK_WRONG_CRANELIFT:-}" == yes ]]; then
      printf '\\n[[package]]\\nname = "cranelift-stale-family"\\nversion = "0.137.0"\\n' >> aot-host/run/Cargo.lock
    fi
  else exit 78; fi
  ;;
metadata)
  if [[ "\${MOCK_FAIL_METADATA:-}" == yes ]]; then exit 88; fi
  printf '{}\\n'
  ;;
tree)
  if [[ "\${MOCK_FAIL_TREE:-}" == yes ]]; then exit 87; fi
  if [[ "\${MOCK_COMPILER_LEAK:-}" == yes ]]; then
    printf 'wasmtime-internal-cranelift v49.0.4\\n'
  else
    printf 'wasmtime v49.0.4\\n'
  fi
  ;;
*) exit 79 ;;
esac
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ores-wasmtime-lock-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  for (const sub of ['scripts', 'aot-host/precompile', 'aot-host/run', 'mockbin'])
    mkdirSync(join(dir, sub), {recursive: true});
  copyFileSync(scriptSource, join(dir, 'scripts/upgrade-wasmtime-49-0-4-locks.sh'));
  writeFileSync(join(dir, 'aot-host/precompile/Cargo.toml'), '[dependencies]\nwasmtime={version="=49.0.4"}\n');
  writeFileSync(join(dir, 'aot-host/run/Cargo.toml'), '[dependencies]\nwasmtime={version="=49.0.4"}\n');
  writeFileSync(join(dir, 'aot-host/precompile/Cargo.lock'), oldPre);
  writeFileSync(join(dir, 'aot-host/run/Cargo.lock'), oldRun);
  writeFileSync(join(dir, 'mockbin/cargo'), mockCargo, {mode: 0o755});
  for (const args of [['init', '-q'], ['config','user.email','testing@example.invalid'],
    ['config','user.name','Test'], ['add','aot-host'], ['commit','-qm','baseline']])
    execFileSync('git', args, {cwd:dir, stdio:'pipe'});
  const locks = () => [readFileSync(join(dir,'aot-host/precompile/Cargo.lock'),'utf8'),
    readFileSync(join(dir,'aot-host/run/Cargo.lock'),'utf8')];
  const run = (opts={}) => spawnSync('/bin/bash',
    [join(dir,'scripts/upgrade-wasmtime-49-0-4-locks.sh')],
    {cwd:dir, encoding:'utf8', env:{...process.env,
      PATH:join(dir,'mockbin')+':'+process.env.PATH,
      MOCK_NEW_PRE:newPre, MOCK_NEW_RUN:newRun, ...opts}});
  return {dir, locks, run};
}

test('both lockfiles change together on simulated successful Cargo graph', t => {
  const f=fixture(t);const p=f.run();
  assert.equal(p.status,0,p.stderr);
  assert.deepEqual(f.locks(),[newPre,newRun]);
  assert.match(p.stdout,/inspect and commit their diffs/);
});
test('second Cargo update failure restores both original lockfiles',t => {
  const f=fixture(t);const p=f.run({MOCK_FAIL_RUNNER:'yes'});
  assert.equal(p.status,89,p.stderr);assert.deepEqual(f.locks(),[oldPre,oldRun]);
  assert.match(p.stderr,/both original lockfiles restored/);
});
test('Cargo metadata failure restores both locks',t => {
  const f=fixture(t);const p=f.run({MOCK_FAIL_METADATA:'yes'});
  assert.equal(p.status,88,p.stderr);assert.deepEqual(f.locks(),[oldPre,oldRun]);
});
test('Cargo tree failure is fatal, rather than mistaken for compiler-free success',t => {
  const f=fixture(t);const p=f.run({MOCK_FAIL_TREE:'yes'});
  assert.equal(p.status,87,p.stderr);assert.deepEqual(f.locks(),[oldPre,oldRun]);
});
test('compiler dependency in runner is rejected with both locks restored',t => {
  const f=fixture(t);const p=f.run({MOCK_COMPILER_LEAK:'yes'});
  assert.equal(p.status,1,p.stderr);assert.match(p.stderr,/unexpectedly gained an embedded compiler/);
  assert.deepEqual(f.locks(),[oldPre,oldRun]);
});
test('stale Wasmtime transitive is rejected rather than accepted by top-level pin',t => {
  const f=fixture(t);const p=f.run({MOCK_OLD_TRANSITIVE:'yes'});
  assert.equal(p.status,1,p.stderr);assert.match(p.stderr,/unpatched Wasmtime\/Pulley/);
  assert.deepEqual(f.locks(),[oldPre,oldRun]);
});
test('staged lock edit cannot be silently replaced',t => {
  const f=fixture(t);
  writeFileSync(join(f.dir,'aot-host/precompile/Cargo.lock'),oldPre+'# intentional local edit\n');
  execFileSync('git',['add','aot-host/precompile/Cargo.lock'],{cwd:f.dir});
  const before=f.locks();const p=f.run();
  assert.equal(p.status,1,p.stderr);assert.match(p.stderr,/pre-existing staged or unstaged edits/);
  assert.deepEqual(f.locks(),before);
});
test('unstaged lock edit cannot be silently replaced',t => {
  const f=fixture(t);
  writeFileSync(join(f.dir,'aot-host/precompile/Cargo.lock'),oldPre+'# local edit\n');
  const before=f.locks();const p=f.run();
  assert.equal(p.status,1,p.stderr);assert.match(p.stderr,/pre-existing staged or unstaged edits/);
  assert.deepEqual(f.locks(),before);
});
test('manifest missing exact patched pin aborts before touching either lock',t => {
  const f=fixture(t);
  writeFileSync(join(f.dir,'aot-host/run/Cargo.toml'),'[dependencies]\nwasmtime={version="=49.0.3"}\n');
  const p=f.run();assert.equal(p.status,1,p.stderr);
  assert.match(p.stderr,/does not pin Wasmtime =49.0.4/);
  assert.deepEqual(f.locks(),[oldPre,oldRun]);
});

test('hard-linked lockfile is rejected before any mutation',t => {
  const f=fixture(t);
  const sentinel=join(f.dir,'external-sentinel.lock');
  linkSync(join(f.dir,'aot-host/precompile/Cargo.lock'),sentinel);
  const before=f.locks();
  const p=f.run();
  assert.equal(p.status,1,p.stderr);
  assert.match(p.stderr,/refusing multiply-linked Cargo lockfile/);
  assert.deepEqual(f.locks(),before);
  assert.equal(readFileSync(sentinel,'utf8'),oldPre);
});
test('symlink lockfile is explicitly rejected, without overwriting target',t => {
  const f=fixture(t);
  const lock=join(f.dir,'aot-host/precompile/Cargo.lock');
  const sentinel=join(f.dir,'external-sentinel.lock');
  renameSync(lock,sentinel);
  symlinkSync(sentinel,lock);
  const p=f.run();
  assert.equal(p.status,1,p.stderr);
  assert.match(p.stderr,/refusing non-regular or symlink Cargo lockfile/);
  assert.equal(readFileSync(sentinel,'utf8'),oldPre);
});
test('Cranelift from an unexpected version family is rejected',t => {
  const f=fixture(t);
  const p=f.run({MOCK_WRONG_CRANELIFT:'yes'});
  assert.equal(p.status,1,p.stderr);
  assert.match(p.stderr,/unpatched Cranelift/);
  assert.deepEqual(f.locks(),[oldPre,oldRun]);
});
