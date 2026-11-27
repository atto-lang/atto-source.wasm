import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Source-local admission checks. Never substitute a fake compiler for actual
// LLVM -> wasm32 -> pooled guest execution. These tests only prove that the
// mandatory entry point fails closed when the real toolchain is unavailable.
const verifier = fileURLToPath(new URL('../scripts/verify-real-source-pooled-actor.mjs', import.meta.url));
const deny = env => {
  const result = spawnSync(process.execPath, [verifier], {
    env: {PATH: process.env.PATH || '', ...env},
    encoding: 'utf8', timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0, 'missing/forged compiler must never be treated as guest PASS');
  assert.doesNotMatch(result.stdout + result.stderr, /REAL_POOLED_ACTOR_GUEST_EXECUTED=YES/);
  return result;
};

test('real pooled guest gate denies absent native LLVM compiler', () => {
  const result = deny({});
  assert.match(result.stderr, /NOT_EXECUTED: a real absolute-path ORESLANG_LLVM_COMPILER is required/);
});

test('real pooled guest gate denies missing immutable compiler hash', () => {
  const result = deny({ORESLANG_LLVM_COMPILER: '/definitely-not-a-real-oreslang-compiler'});
  assert.match(result.stderr, /NOT_EXECUTED: exact ORESLANG_LLVM_COMPILER_SHA256 pin is mandatory/);
});

test('real pooled guest gate denies malformed compiler hash before tests', () => {
  const result = deny({
    ORESLANG_LLVM_COMPILER: '/definitely-not-a-real-oreslang-compiler',
    ORESLANG_LLVM_COMPILER_SHA256: 'not-a-sha256'
  });
  assert.match(result.stderr, /NOT_EXECUTED: exact ORESLANG_LLVM_COMPILER_SHA256 pin is mandatory/);
});

test('real pooled guest gate rejects a pinned but nonexistent executable', () => {
  const result = deny({
    ORESLANG_LLVM_COMPILER: '/definitely-not-a-real-oreslang-compiler',
    ORESLANG_LLVM_COMPILER_SHA256: '0'.repeat(64)
  });
  assert.match(result.stdout + result.stderr, /(?:ENOENT|no such file|not a regular file|actor compilation command failed)/i);
});

test('real guest verifier rejects wrong compiler SHA before any test invocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ores-wrong-pin-'));
  try {
    const binary = join(dir, 'candidate.bin');
    writeFileSync(binary, 'arbitrary test bytes', {mode: 0o700});
    chmodSync(binary, 0o700);
    const result = deny({
      ORESLANG_LLVM_COMPILER: binary,
      ORESLANG_LLVM_COMPILER_SHA256: '0'.repeat(64)
    });
    assert.match(result.stderr, /compiler executable SHA-256 mismatch/);
    assert.doesNotMatch(result.stdout + result.stderr, /NOT_VERIFIED: real source-actor guest test inventory/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('real guest verifier rejects a symlink, even with a matching target digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ores-symlink-pin-'));
  try {
    const target = join(dir, 'candidate.bin');
    const alias = join(dir, 'alias.bin');
    const bytes = Buffer.from('ordinary data used only for admission rejection');
    writeFileSync(target, bytes, {mode: 0o700});
    chmodSync(target, 0o700);
    symlinkSync(target, alias);
    const result = deny({
      ORESLANG_LLVM_COMPILER: alias,
      ORESLANG_LLVM_COMPILER_SHA256: createHash('sha256').update(bytes).digest('hex')
    });
    assert.match(result.stderr, /symlink or special input file is forbidden/);
    assert.doesNotMatch(result.stdout + result.stderr, /NOT_VERIFIED: real source-actor guest test inventory/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('real guest verifier rejects a non-executable candidate with a matching digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ores-unexecutable-pin-'));
  try {
    const binary = join(dir, 'candidate.bin');
    const bytes = Buffer.from('ordinary non-executable candidate');
    writeFileSync(binary, bytes, {mode: 0o600});
    chmodSync(binary, 0o600);
    const result = deny({
      ORESLANG_LLVM_COMPILER: binary,
      ORESLANG_LLVM_COMPILER_SHA256: createHash('sha256').update(bytes).digest('hex')
    });
    assert.match(result.stderr, /compiler is empty or not executable/);
    assert.doesNotMatch(result.stdout + result.stderr, /NOT_VERIFIED: real source-actor guest test inventory/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
