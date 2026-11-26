// Synthetic runner tests. Never compiler execution evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,cpSync,copyFileSync,writeFileSync,readFileSync,chmodSync,symlinkSync,linkSync,realpathSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtureDir='tests/fixtures/std-metrics-json-zorde';
const adapter='scripts/verify-std-metrics-json-zorde-guest.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const mode of ['valid','wrong-pin','manifest-drift','fixture-drift','runner-link','runner-hardlink','fixture-link','runner-mutates','fixture-mutates','extra-line','nonzero','invalid-utf8']){
  test('synthetic '+mode,()=>{
    const t=mkdtempSync(path.join(realpathSync(tmpdir()),'atto-guest-admission-'));
    try{
      mkdirSync(path.join(t,'scripts'));mkdirSync(path.join(t,'tests/fixtures'),{recursive:true});
      copyFileSync(path.join(root,adapter),path.join(t,adapter));
      cpSync(path.join(root,fixtureDir),path.join(t,fixtureDir),{recursive:true});
      const base=path.join(t,fixtureDir),manifest=path.join(base,'expected-stdout.json');
      const m=JSON.parse(readFileSync(manifest,'utf8'));
      for(const [name,v] of Object.entries(m.fixtures))writeFileSync(path.join(t,name+'.out'),v.stdout_lines.join('\n')+'\n');
      let runner=path.join(t,'runner');
      let body='#!/bin/sh\nset -eu\n';
      body+='test -z "${BASH_ENV-}${GIT_DIR-}${UNAPPROVED-}"\n';
      body+='name="$(basename "$1" .atto)"\n';
      body+='cat "'+t+'/$name.out"\n';
      if(mode==='runner-mutates')body+='printf "#change\\n" >> "$0"\n';
      if(mode==='fixture-mutates')body+='printf x >> "$1"\n';
      if(mode==='extra-line')body+='printf "\\n"\n';
      if(mode==='nonzero')body+='exit 7\n';
      if(mode==='invalid-utf8')body+='printf "\\377"\n';
      writeFileSync(runner,body);chmodSync(runner,0o700);
      let pin=hash(readFileSync(runner));
      if(mode==='wrong-pin')pin='0'.repeat(64);
      if(mode==='manifest-drift')appendFileSync(manifest,' ');
      if(mode==='fixture-drift')appendFileSync(path.join(base,'json.atto'),' ');
      if(mode==='runner-link'){symlinkSync(runner,runner+'.link');runner+='.link';}
      if(mode==='runner-hardlink')linkSync(runner,runner+'.hardlink');
      if(mode==='fixture-link'){const p=path.join(base,'json.atto');copyFileSync(p,p+'.copy');rmSync(p);symlinkSync(p+'.copy',p);}
      const out=spawnSync(process.execPath,[path.join(t,adapter),runner,pin],{encoding:'utf8',timeout:15000,env:{...process.env,BASH_ENV:'/invalid',GIT_DIR:'/invalid',UNAPPROVED:'x'}});
      assert.equal(out.status,mode==='valid'?0:1,out.stderr);
      if(mode==='valid')assert.match(out.stdout,/ATTO_STDLIB_CANDIDATE_GUEST_STDOUT_MATCH=127/);
      else assert.doesNotMatch(out.stdout,/ATTO_STDLIB_CANDIDATE_GUEST_STDOUT_MATCH/);
      assert.doesNotMatch(out.stdout,/ATTO_STDLIB_PARITY=VERIFIED/);
    }finally{rmSync(t,{recursive:true,force:true});}
  });
}
