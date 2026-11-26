import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runRefinementCases} from './browser-refinement-corpus.mjs';
const [path,pin,head,tree,corpus]=process.argv.slice(2);
if(!path)throw Error('usage: node scripts/verify-browser-refinement-casts.mjs compiler.wasm sha256 sourceHead sourceTree');
const typed=corpus?(await import(pathToFileURL(resolve(corpus)).href)).typedBindingCases:null;
await runRefinementCases(await readFile(path),pin,head,tree,console.log,typed);
