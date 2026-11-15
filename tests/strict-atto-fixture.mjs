// Source-fixture provenance guard for compiler-backed guest tests.
// This is a bounded host-side integrity check, NOT evidence of guest execution.
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const identical = (a, b) => a.dev === b.dev && a.ino === b.ino;

export async function readStrictAttoFixture(url, maxBytes = 4096) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)
    throw new TypeError('invalid fixture byte budget');
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK))
    throw new Error('no-follow fixture reads unsupported on this host');
  const path = fileURLToPath(url);
  if (!path.endsWith('.atto')) throw new Error('only canonical .atto fixtures are allowed');
  const directory = dirname(path);
  const [parentBefore, leafBefore] = await Promise.all([lstat(directory), lstat(path)]);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink())
    throw new Error('symlinked or non-directory fixture parent');
  if (!leafBefore.isFile() || leafBefore.isSymbolicLink())
    throw new Error('symlinked or nonregular fixture');
  if (leafBefore.size < 1 || leafBefore.size > maxBytes)
    throw new Error('fixture byte budget exceeded');

  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const before = await fd.stat();
    if (!before.isFile() || !identical(before, leafBefore) ||
        before.size < 1 || before.size > maxBytes)
      throw new Error('fixture changed during open');
    bytes = Buffer.alloc(before.size);
    let used = 0;
    while (used < bytes.length) {
      const {bytesRead} = await fd.read(bytes, used, bytes.length - used, used);
      if (bytesRead === 0) throw new Error('fixture truncated during snapshot');
      used += bytesRead;
    }
    const {bytesRead: extra} = await fd.read(Buffer.alloc(1), 0, 1, used);
    if (extra) throw new Error('fixture expanded during snapshot');
    const after = await fd.stat();
    if (!after.isFile() || !identical(before, after) || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error('fixture mutated during snapshot');
  } finally {
    await fd.close();
  }
  const [parentAfter, leafAfter] = await Promise.all([lstat(directory), lstat(path)]);
  if (!parentAfter.isDirectory() || !identical(parentBefore, parentAfter) ||
      !leafAfter.isFile() || !identical(leafBefore, leafAfter) ||
      leafAfter.size !== leafBefore.size ||
      leafAfter.mtimeMs !== leafBefore.mtimeMs ||
      leafAfter.ctimeMs !== leafBefore.ctimeMs)
    throw new Error('fixture path changed during snapshot');
  return bytes;
}
