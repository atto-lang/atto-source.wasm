// Verify claimed LLVM source identity against an actual local Git object graph.
// This is independent of the caller's SHA-shaped environment declarations.
// It does NOT by itself prove that the compiler executable was built from HEAD.
import {spawnSync} from 'node:child_process';
import {lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, resolve, join} from 'node:path';

const SHA1 = /^[a-f0-9]{40}$/;
function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding:'utf8', timeout:10000, maxBuffer:1024*1024,
    windowsHide:true, env:{PATH:process.env.PATH || '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM:'1', GIT_TERMINAL_PROMPT:'0'}
  });
  if (r.error || r.signal || r.status !== 0)
    throw Error('pinned LLVM source checkout Git verification failed: ' +
      String(r.error?.message || r.stderr || 'nonzero Git exit').slice(0,400));
  return r.stdout.trim();
}
export function verifyPinnedLlvmCheckout({
  sourceDir, sourceSha, sourceTree
} = {}) {
  if (typeof sourceDir !== 'string' || !isAbsolute(sourceDir))
    throw Error('absolute ORESLANG_LLVM_SOURCE_DIR is mandatory');
  if (typeof sourceSha !== 'string' || !SHA1.test(sourceSha) ||
      typeof sourceTree !== 'string' || !SHA1.test(sourceTree))
    throw Error('exact LLVM source commit and tree pins are mandatory');
  if (lstatSync(sourceDir).isSymbolicLink())
    throw Error('LLVM source checkout may not be a symlink');
  const root = realpathSync(sourceDir);
  if (root !== resolve(sourceDir) || !lstatSync(root).isDirectory())
    throw Error('LLVM source checkout must be a real absolute directory');
  // O_NOFOLLOW protects only a file's last component, not build/ itself.
  let buildStat;
  try {
    buildStat = lstatSync(join(root, 'build'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (buildStat && (!buildStat.isDirectory() || buildStat.isSymbolicLink()))
    throw Error('LLVM build directory must be a real non-symlink directory');
  if (git(root, ['rev-parse', '--show-toplevel']) !== root)
    throw Error('LLVM source directory must be the Git root, not a subdirectory');
  const actualSha = git(root, ['rev-parse', 'HEAD']);
  const actualTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const commitTree = git(root, ['show', '-s', '--format=%T', 'HEAD']);
  if (actualSha !== sourceSha || actualTree !== sourceTree ||
      commitTree !== sourceTree)
    throw Error('LLVM source checkout commit/tree mismatch');
  if (git(root, ['status', '--porcelain', '--untracked-files=no']) !== '')
    throw Error('LLVM source checkout has modified tracked files');
  // Verify the effective source worktree, not just tracked Git objects.
  // Untracked/ignored files outside build/ can shadow headers, CMake modules
  // or compiler resources without changing the root Git tree.
  for (const args of [
    ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude)build'],
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--', '.', ':(exclude)build']
  ]) {
    if (git(root, args) !== '')
      throw Error('LLVM source checkout has untracked or ignored files outside build');
  }
  return Object.freeze({sourceSha:actualSha, sourceTree:actualTree,
    validatedGitCheckout:true, binaryBuiltFromSourceAuthenticated:false});
}
