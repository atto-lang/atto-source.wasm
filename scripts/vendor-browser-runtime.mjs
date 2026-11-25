/** Vendor the host-only tenant scheduler from a clean canonical source.js tree. */
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
if(process.argv.length!==3)throw Error('usage: node scripts/vendor-browser-runtime.mjs /path/to/oreslang-source.js');
const source=await realpath(process.argv[2]);
const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw Error('source.js checkout must be clean');
const remote=git('remote','get-url','origin');
if(!/github\.com[:/]ores-truffle-oreslang\/oreslang-source\.js(?:\.git)?$/.test(remote))throw Error('unexpected source.js origin');
const files={};
for(const [src,dest] of [['src/canonical-actor-runtime.mjs','src/browser-tenant-runtime.mjs'],['src/tenant-turn-queue.mjs','src/tenant-turn-queue.mjs']]){
 const bytes=await readFile(source+'/'+src);
 const expected=execFileSync('git',['-C',source,'show','HEAD:'+src]);
 if(!bytes.equals(expected))throw Error('source file differs from Git blob: '+src);
 await writeFile(new URL('../'+dest,import.meta.url),bytes);
 files[dest]={source_path:src,sha256:createHash('sha256').update(bytes).digest('hex')};
}
const receipt={schema:'oreslang.browser.tenant-runtime.vendor.v1',source_repository:'ores-truffle-oreslang/oreslang-source.js',source_head:git('rev-parse','HEAD'),source_tree:git('rev-parse','HEAD^{tree}'),files};
await writeFile(new URL('../test-support/browser-runtime.receipt.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log(receipt);
