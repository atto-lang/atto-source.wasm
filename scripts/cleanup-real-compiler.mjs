// Clean up a private, mkdtemp-owned real compiler verification workspace.
// Atomic releases intentionally seal directories as 0500; recurse over real
// directories only, never through symlinks to arbitrary outside paths.
import {lstat,chmod,readdir,rm} from "node:fs/promises";
import {join} from "node:path";

export async function cleanupRealCompilerWorkspace(work) {
  let count = 0;
  async function unseal(path) {
    if (++count > 2048) throw Error("compiler workspace exceeds cleanup entry budget");
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw Error("compiler workspace cleanup encountered foreign-owned directory");
    await chmod(path, 0o700);
    for (const entry of await readdir(path, {withFileTypes:true})) {
      if (entry.isDirectory()) await unseal(join(path, entry.name));
    }
  }
  await unseal(work);
  await rm(work, {recursive:true,force:true});
}
