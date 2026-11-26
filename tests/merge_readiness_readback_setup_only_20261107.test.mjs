import test from 'node:test';
import assert from 'node:assert/strict';
import {REPOS,assess,inspect_live} from '../scripts/merge_readiness_probe_20261106.mjs';

// Advisory-model-only cases. No real GitHub checks or guest code execute here.
const HEAD='a'.repeat(40),BASE='b'.repeat(40),NEXT='c'.repeat(40);
function fixture(b) {
  const [slug,id]=REPOS[b];
  return {
    repo:{id,full_name:slug,private:true,archived:false,disabled:false},
    main:{name:'main',protected:true,commit:{sha:BASE}},
    pr:{number:53,state:'open',draft:false,mergeable:true,
      base:{ref:'main',sha:BASE,repo:{id}},head:{sha:HEAD,repo:{id}},
      user:{login:'the1mills'}},
    reviews:[{id:1,user:{login:'ORESoftware'},state:'APPROVED',
      commit_id:HEAD,submitted_at:'2026-11-07T01:01:00Z'}],
    runs:{total_count:1,workflow_runs:[{id:71,head_sha:HEAD,event:'pull_request',
      status:'completed',conclusion:'success',run_attempt:1,
      repository:{id},head_repository:{id}}]},
    jobs:{total_count:1,jobs:[{id:72,run_id:71,head_sha:HEAD,run_attempt:1,
      status:'completed',conclusion:'success',runner_id:95,
      runner_name:'GitHub Actions 1',name:'test',steps:[
        {name:'Set up job',status:'completed',conclusion:'success'},
        {name:'Run native tests',status:'completed',conclusion:'success'}]}]}
  };
}
const clone=x=>JSON.parse(JSON.stringify(x));
function mock(b,change=()=>{}) {
  const data=fixture(b), counts=new Map(), prefix='repos/'+REPOS[b][0]+'/';
  const get=(path,token)=>{
    assert.equal(token,'test-only-token');
    const count=(counts.get(path)||0)+1; counts.set(path,count);
    let key;
    if(path===prefix.slice(0,-1))key='repo';
    else if(path===prefix+'branches/main')key='main';
    else if(path===prefix+'pulls/53')key='pr';
    else if(path===prefix+'pulls/53/reviews?per_page=100')key='reviews';
    else if(path===prefix+'actions/runs?head_sha='+HEAD+'&event=pull_request&per_page=100')key='runs';
    else if(path===prefix+'actions/runs/71/jobs?per_page=100')key='jobs';
    else throw Error('unexpected API endpoint: '+path);
    const x=clone(data[key]);
    if(count===2)change(key,x);
    return x;
  };
  return {get,counts,prefix};
}
async function live(b,change) {
  const m=mock(b,change);
  const value=await inspect_live(b,53,HEAD,m.get,'test-only-token');
  return {value,m};
}
function denial(r) {
  assert.equal(r.decision,'BLOCKED');
  assert.equal(r.merge_authorized,false);
  assert.equal(r.private_source_export_authorized,false);
  assert.equal(r.guest_parity_certified,false);
}
const drift=[
  ['PR head changed',(key,x)=>{if(key==='pr')x.head.sha=NEXT;}],
  ['PR base changed',(key,x)=>{if(key==='pr')x.base.sha=NEXT;}],
  ['PR closed',(key,x)=>{if(key==='pr')x.state='closed';}],
  ['PR draft changed',(key,x)=>{if(key==='pr')x.draft=true;}],
  ['PR mergeability changed',(key,x)=>{if(key==='pr')x.mergeable=false;}],
  ['PR author changed',(key,x)=>{if(key==='pr')x.user.login='other';}],
  ['main head moved',(key,x)=>{if(key==='main')x.commit.sha=NEXT;}],
  ['main unprotected',(key,x)=>{if(key==='main')x.protected=false;}],
  ['repo public',(key,x)=>{if(key==='repo')x.private=false;}],
  ['repo ID changed',(key,x)=>{if(key==='repo')x.id++;}],
  ['review dismissed',(key,x)=>{if(key==='reviews')x[0].state='DISMISSED';}],
  ['review commented',(key,x)=>{if(key==='reviews')x[0].state='COMMENTED';}],
  ['review commit drift',(key,x)=>{if(key==='reviews')x[0].commit_id=NEXT;}],
  ['review author changed',(key,x)=>{if(key==='reviews')x[0].user.login='other';}],
  ['review removed',(key,x)=>{if(key==='reviews')x.splice(0);}],
  ['new change request',(key,x)=>{if(key==='reviews')x.push({
    id:2,user:{login:'other'},state:'CHANGES_REQUESTED',
    commit_id:HEAD,submitted_at:'2026-11-07T02:00:00Z'});}]
];
const setup=[
  'Run actions/checkout@v4','Run actions/setup-node@v4',
  'Run actions/cache@v4','Run actions/cache/save@v4',
  'Run actions/upload-artifact@v4','Run actions/download-artifact@v4',
  'Checkout repository','Check out source','Set up Node 22','Setup Python',
  'Cache dependencies','Restore cache','Save cache','Install dependencies',
  'Run npm ci','Run npm install','Run pnpm install','Run yarn install',
  'Run dotnet restore','Run cargo fetch','Upload artifacts','Download artifact'
];
const work=['Execute compiled guest tests','Run native LLVM compiler tests',
  'Run npm test','Run dotnet test','Compile and execute AttoLang guest'];
for(const b of Object.keys(REPOS)) {
  test(b+': stable live readback remains advisory',async()=>{
    const {value,m}=await live(b);
    assert.equal(value.decision,'REQUIRES_INDEPENDENT_RELEASE_REVIEW');
    assert.equal(value.merge_authorized,false);
    for(const end of ['', 'branches/main','pulls/53','pulls/53/reviews?per_page=100']){
      const path=end?m.prefix+end:m.prefix.slice(0,-1);
      assert.equal(m.counts.get(path),2);
    }
  });
  for(const [label,mutate] of drift)
    test(b+': reject readback drift '+label,async()=>{
      await assert.rejects(()=>live(b,mutate),/drift during evidence capture/);
    });
  for(const name of setup)
    test(b+': deny setup-only step '+name,()=>{
      const f=fixture(b);
      f.jobs.jobs[0].steps=[{name,status:'completed',conclusion:'success'}];
      denial(assess({repo:f.repo,main:f.main,pr:f.pr,reviews:f.reviews,
        runs:[{run:f.runs.workflow_runs[0],jobs:f.jobs.jobs}]},b,53,HEAD));
    });
  for(const name of work)
    test(b+': substantive step advisory '+name,()=>{
      const f=fixture(b);
      f.jobs.jobs[0].steps=[{name,status:'completed',conclusion:'success'}];
      const r=assess({repo:f.repo,main:f.main,pr:f.pr,reviews:f.reviews,
        runs:[{run:f.runs.workflow_runs[0],jobs:f.jobs.jobs}]},b,53,HEAD);
      assert.equal(r.decision,'REQUIRES_INDEPENDENT_RELEASE_REVIEW');
      assert.equal(r.merge_authorized,false);
      assert.equal(r.guest_parity_certified,false);
    });
}
