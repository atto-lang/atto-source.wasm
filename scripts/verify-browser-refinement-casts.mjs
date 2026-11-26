import {readFile} from 'node:fs/promises';
import {runRefinementCases} from './browser-refinement-corpus.mjs';
const [path,pin,head,tree]=process.argv.slice(2);
if(!path)throw Error('usage: node scripts/verify-browser-refinement-casts.mjs compiler.wasm sha256 sourceHead sourceTree');
await runRefinementCases(await readFile(path),pin,head,tree);
