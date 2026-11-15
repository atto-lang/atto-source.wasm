import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readStrictAttoFixture} from './strict-atto-fixture.mjs';

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'atto-fixture-hardening-'));
  t.after(async () => rm(root, {recursive: true, force: true}));
  return root;
}

test('reads bounded immutable .atto fixture from a regular descriptor', async t => {
  const root = await sandbox(t), file = join(root, 'guest.atto');
  await writeFile(file, 'pub fnc main(): int { return 42; }\n');
  assert.equal((await readStrictAttoFixture(pathToFileURL(file))).toString(),
    'pub fnc main(): int { return 42; }\n');
});

test('rejects identical-content symlink fixture', async t => {
  const root = await sandbox(t), actual = join(root, 'original.atto');
  await writeFile(actual, 'pub fnc main(): int { return 42; }\n');
  const alias = join(root, 'alias.atto');
  await symlink(actual, alias);
  await assert.rejects(readStrictAttoFixture(pathToFileURL(alias)), /symlinked/);
});

test('rejects symlinked fixture parent even with identical content', async t => {
  const root = await sandbox(t), originals = join(root, 'originals');
  await mkdir(originals);
  await writeFile(join(originals, 'guest.atto'), 'pub fnc main(): int { return 42; }\n');
  const alias = join(root, 'aliases');
  await symlink(originals, alias);
  await assert.rejects(readStrictAttoFixture(pathToFileURL(join(alias, 'guest.atto'))), /symlinked/);
});

test('rejects oversized fixtures before allocation', async t => {
  const root = await sandbox(t), file = join(root, 'oversized.atto');
  await writeFile(file, Buffer.alloc(4097, 65));
  await assert.rejects(readStrictAttoFixture(pathToFileURL(file)), /byte budget/);
});

test('rejects empty or non-.atto fixture inputs', async t => {
  const root = await sandbox(t), empty = join(root, 'empty.atto'), other = join(root, 'guest.ores');
  await writeFile(empty, '');
  await writeFile(other, 'pub fnc main(): int { return 42; }\n');
  await assert.rejects(readStrictAttoFixture(pathToFileURL(empty)), /byte budget/);
  await assert.rejects(readStrictAttoFixture(pathToFileURL(other)), /only canonical/);
});

test('rejects nonregular fixture directory before open', async t => {
  const root = await sandbox(t), file = join(root, 'bad-parent.atto', 'guest.atto');
  await writeFile(join(root, 'bad-parent.atto'), 'not a directory');
  await assert.rejects(readStrictAttoFixture(pathToFileURL(file)), {code: 'ENOTDIR'});
});

test('rejects invalid fixture budget without filesystem activity', async t => {
  const root = await sandbox(t);
  await assert.rejects(readStrictAttoFixture(pathToFileURL(join(root, 'guest.atto')), 0), /invalid fixture byte budget/);
  await assert.rejects(readStrictAttoFixture(pathToFileURL(join(root, 'guest.atto')), 65537), /invalid fixture byte budget/);
});

test('rejects symlinked grandparent beyond fixture directory', async t => {
  const root = await sandbox(t);
  const realGrandparent = join(root, 'real-grandparent');
  await mkdir(realGrandparent);
  const realParent = join(realGrandparent, 'nested');
  await mkdir(realParent);
  await writeFile(join(realParent, 'guest.atto'), 'pub fnc main(): int { return 42; }\n');
  const aliasGrandparent = join(root, 'alias-grandparent');
  await symlink(realGrandparent, aliasGrandparent);
  await assert.rejects(
    readStrictAttoFixture(pathToFileURL(join(aliasGrandparent, 'nested', 'guest.atto'))),
    /symlinked or non-directory fixture ancestor/);
});
