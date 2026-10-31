import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedActorThreadSource as check} from '../src/actor-max-threads-source-policy.mjs';
const b = text => new TextEncoder().encode(text);
const rejected = [
 ['public actor', 'define pub actor Worker as end', /source actor execution unsupported/],
 ['pub-define actor', 'pub define actor Worker as end', /source actor execution unsupported/],
 ['HTTP actor', 'define http actor Worker as end', /source actor execution unsupported/],
 ['serial HTTP actor', 'define serial http actor Worker as end', /source actor execution unsupported/],
 ['public HTTP actor', 'define pub http actor Worker as end', /source actor execution unsupported/],
 ['TCP actor', 'define tcp actor Worker as end', /source actor execution unsupported/],
 ['WS actor', 'define ws actor Worker as end', /source actor execution unsupported/],
 ['public scheduler enum', 'define pub enum MaxActorThreads as LOW int=1 end', /built-in MaxActorThreads enum unsupported/],
 ['pub-define scheduler enum', 'pub define enum MaxActorThreads as LOW int=1 end', /built-in MaxActorThreads enum unsupported/],
 ['Unicode public actor', 'define\u0085pub\u2028actor Worker as end', /source actor execution unsupported/],
];
for(const [name, source, diagnostic] of rejected) test(name, () => assert.throws(() => check(b(source)), diagnostic));
const accepted = [
 ['ordinary public class', 'define pub class Worker as end'],
 ['non-reserved enum', 'define pub enum Color as RED int=1 end'],
 ['commented actor', '// define serial http actor Worker as end\nfnc main():int{return 42;}'],
 ['string actor', 'fnc main():int{const s="define pub actor Foo as end"; return 42;}'],
 ['ordinary pub module', 'define pub module Worker as end'],
];
for(const [name, source] of accepted) test(name, () => assert.doesNotThrow(() => check(b(source))));
