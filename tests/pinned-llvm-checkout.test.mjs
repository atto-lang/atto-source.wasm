import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyPinnedLlvmCheckout as verify} from '../scripts/verify-pinned-llvm-checkout.mjs';

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args],
    {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  assert.equal(r.status,0,String(r.stderr));
  return r.stdout.trim();
}
test('pinned LLVM compiler source must be an independently matching Git checkout',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-llvm-provenance-'));
  try {
    git(dir,'init','-q');
    await writeFile(join(dir,'compiler-source.cpp'),'int main() { return 0; }\n');
    git(dir,'add','compiler-source.cpp');
    git(dir,'-c','user.name=Oreslang Test','-c',
      'user.email=oreslang-test@example.invalid','commit','-qm','test fixture');
    const sourceSha=git(dir,'rev-parse','HEAD');
    const sourceTree=git(dir,'rev-parse','HEAD^{tree}');
    const ok=verify({sourceDir:dir,sourceSha,sourceTree});
    assert.deepEqual(ok,{sourceSha,sourceTree,validatedGitCheckout:true,
      binaryBuiltFromSourceAuthenticated:false});
    // A matching Git commit/tree must not admit additional source bytes.
    const extra=join(dir,'rogue-untracked.hpp');
    await writeFile(extra,'#define INJECTED 1\n');
    assert.throws(()=>verify({sourceDir:dir,sourceSha,sourceTree}),
      /untracked or ignored files outside build/);
    await rm(extra);
    await writeFile(join(dir,'.git','info','exclude'),'rogue-ignored.hpp\n');
    const ignored=join(dir,'rogue-ignored.hpp');
    await writeFile(ignored,'#define INJECTED_IGNORED 1\n');
    assert.throws(()=>verify({sourceDir:dir,sourceSha,sourceTree}),
      /untracked or ignored files outside build/);
    await rm(ignored);
    // Build outputs are allowed only under the isolated untracked build tree.
    await writeFile(join(dir,'build-output.txt'),'invalid outside build\n');
    assert.throws(()=>verify({sourceDir:dir,sourceSha,sourceTree}),
      /untracked or ignored files outside build/);
    await rm(join(dir,'build-output.txt'));
    assert.equal(verify({sourceDir:dir,sourceSha,sourceTree}).validatedGitCheckout,true);
    assert.throws(()=>verify({sourceDir:dir,sourceSha:'a'.repeat(40),sourceTree}),
      /commit\/tree mismatch/);
    assert.throws(()=>verify({sourceDir:dir,sourceSha,sourceTree:'b'.repeat(40)}),
      /commit\/tree mismatch/);
    assert.throws(()=>verify({sourceDir:dir,sourceSha,sourceTree:''}),
      /source commit and tree pins are mandatory/);
    assert.throws(()=>verify({sourceDir:null,sourceSha,sourceTree}),
      /absolute ORESLANG_LLVM_SOURCE_DIR/);
    await writeFile(join(dir,'compiler-source.cpp'),'int main() { return 99; }\n');
    assert.throws(()=>verify({sourceDir:dir,sourceSha,sourceTree}),
      /modified tracked files/);
    if(process.platform!=='win32'){
      const alias=join(dir,'source-symlink');
      await symlink(dir,alias);
      assert.throws(()=>verify({sourceDir:alias,sourceSha,sourceTree}),
        /may not be a symlink/);
    }
  }finally {await rm(dir,{recursive:true,force:true});}
});
