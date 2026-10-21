#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, lstat, stat, rm} from 'node:fs/promises';
import {join, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {compileOresToWasm} from './compile-ores.mjs';

// The Wasm bridge does not own a general Oreslang source parser. Admit only
// this closed literal-main grammar, then require the REAL LLVM->Wasm compile,
// link, entry ABI, import and bounded-memory checks to finish successfully.
// This is NOT a claim about general actors/Tasks/termination/GC.
const PURE_MAIN = /^[ \t\r\n]*(?:pub[ \t\r\n]+)?fnc[ \t\r\n]+main[ \t\r\n]*\([ \t\r\n]*\)[ \t\r\n]*:[ \t\r\n]*int[ \t\r\n]*\{[ \t\r\n]*return[ \t\r\n]+(?:0|[1-9][0-9]{0,17})[ \t\r\n]*;[ \t\r\n]*\}[ \t\r\n]*$/;
export function admitLiteralSource(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1048576 || !bytes.length)
    throw Error('invalid/oversized source byte snapshot');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw Error('BOM source not admitted for exact-byte identity');
  const source = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if (!PURE_MAIN.test(source)) throw Error('unsupported literal-main source; effects unmodelled');
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export async function compileStaticFacts({compiler,source,clang,compilerSha256}) {
  if (!isAbsolute(compiler) || !isAbsolute(source))
    throw Error('compiler and source paths must be absolute');
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1048576)
    throw Error('source must be a bounded regular non-symlink file');
  const bytes = await readFile(source);
  const after = await stat(source);
  if (before.ino!==after.ino || before.dev!==after.dev ||
      before.size!==after.size || before.mtimeMs!==after.mtimeMs ||
      before.ctimeMs!==after.ctimeMs)
    throw Error('source changed during snapshot');
  const unit = admitLiteralSource(bytes);
  const temp = await mkdtemp(join(tmpdir(),'ores-wasm-facts-v0-'));
  try {
    const out = join(temp,'guest.wasm');
    const record = await compileOresToWasm({
      compiler,source,output:out,exportName:'main',clang,compilerSha256,
      publication:'legacy'
    });
    if (record.sourceSha256 !== unit.slice(7) ||
        !/^[a-f0-9]{64}$/.test(record.wasmSha256))
      throw Error('real compiler output provenance does not match exact source bytes');
    return {
      version:'ores-static-facts/v0',unit,
      procedures:[{id:'__root__.main/0',loops:[]}],edges:[],
      taint_sources:[],flows:[],sinks:[],permission_checks:[]
    };
  } finally {await rm(temp,{recursive:true,force:true});}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const opts=Object.create(null);
    for (const arg of process.argv.slice(2)) {
      const match=/^--(compiler|source|clang|compiler-sha256)=(.+)$/.exec(arg);
      if(!match || Object.hasOwn(opts,match[1]))throw Error('unknown/duplicate option');
      opts[match[1]]=match[2];
    }
    if(!opts.compiler || !opts.source)throw Error('required --compiler and --source');
    const facts=await compileStaticFacts({
      compiler:opts.compiler,source:opts.source,clang:opts.clang,
      compilerSha256:opts['compiler-sha256']
    });
    process.stdout.write(JSON.stringify(facts)+'\n');
  } catch(error){console.error('ORES-ANALYZE-UNSUPPORTED:',error.message);process.exitCode=2;}
}
