import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REPOS, inspect_live} from '../scripts/merge_readiness_probe_20261106.mjs';

// Synthetic, read-only mutable-GitHub snapshots. These do not prove that GitHub
// currently enforces required reviews/CI, nor do they grant merge authority.
const HEAD='a'.repeat(40), BASE='b'.repeat(40), OTHER='c'.repeat(40);
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(backend) {
  const [slug,id]=REPOS[backend],prefix='repos/'+slug+'/';
  const keys={
    repo:'repos/'+slug, main:prefix+'branches/main',
    pr:prefix+'pulls/47',
    reviews:prefix+'pulls/47/reviews?per_page=100',
    runs:prefix+'actions/runs?head_sha='+HEAD+'&event=pull_request&per_page=100',
    jobs:prefix+'actions/runs/701/jobs?per_page=100'
  };
  const values={
    [keys.repo]:{id,full_name:slug,private:true,archived:false,disabled:false},
    [keys.main]:{name:'main',protected:true,commit:{sha:BASE}},
    [keys.pr]:{number:47,state:'open',draft:false,mergeable:true,
      base:{ref:'main',sha:BASE,repo:{id}},head:{sha:HEAD,repo:{id}},
      user:{login:'the1mills'}},
    [keys.reviews]:[{id:401,user:{login:'ORESoftware'},
      state:'APPROVED',commit_id:HEAD,submitted_at:'2026-11-07T20:00:00Z'}],
    [keys.runs]:{total_count:1,workflow_runs:[{id:701,head_sha:HEAD,
      event:'pull_request',status:'completed',conclusion:'success',run_attempt:2,
      repository:{id},head_repository:{id}}]},
    [keys.jobs]:{total_count:1,jobs:[{id:801,run_id:701,head_sha:HEAD,
      run_attempt:2,status:'completed',conclusion:'success',runner_id:99,
      runner_name:'GitHub Actions 99',name:'Native guest conformance',
      steps:[{name:'Set up job',status:'completed',conclusion:'success'},
        {name:'Compile and execute native guest',status:'completed',
          conclusion:'success'}]}]}
  };
  return {keys,values};
}
function injected(f,mutate=()=>{}, failOnSecond=null) {
  const first=copy(f.values),second=copy(f.values),reads=new Map();
  mutate(second,f.keys);
  const get=async(path,token)=>{
    assert.equal(token,'synthetic-token','no credential fallback');
    reads.set(path,(reads.get(path)||0)+1);
    const n=reads.get(path);
    if(n>1 && path===failOnSecond) throw Error('postflight GitHub read unavailable');
    assert.ok(Object.hasOwn(first,path),'unexpected requested endpoint: '+path);
    return copy(n===1?first[path]:second[path]);
  };
  return {get,reads};
}
function advisory(x) {
  assert.equal(x.decision,'REQUIRES_INDEPENDENT_RELEASE_REVIEW');
  assert.deepEqual(x.failures,[]);
  assert.equal(x.merge_authorized,false);
  assert.equal(x.private_source_export_authorized,false);
  assert.equal(x.guest_parity_certified,false);
}
function blocked(x) {
  assert.equal(x.decision,'BLOCKED');
  assert.ok(x.failures.length>0);
  assert.equal(x.merge_authorized,false);
  assert.equal(x.private_source_export_authorized,false);
}
for(const backend of Object.keys(REPOS)) {
  test(backend+': stable double-read remains advisory, never a merge permit',async()=>{
    const f=fixture(backend),mock=injected(f);
    const result=await inspect_live(backend,47,HEAD,mock.get,'synthetic-token');
    advisory(result);
    for(const name of ['repo','main','pr','reviews','runs'])
      assert.equal(mock.reads.get(f.keys[name]),2,'missing second read: '+name);
    assert.equal(mock.reads.get(f.keys.jobs),1,'single bounded job list read');
  });
  test(backend+': review array reorder is not a false TOCTOU signal',async()=>{
    const f=fixture(backend);
    f.values[f.keys.reviews].push({id:402,user:{login:'visitor'},
      state:'COMMENTED',commit_id:HEAD,submitted_at:'2026-11-07T20:01:00Z'});
    const mock=injected(f,(v,k)=>v[k.reviews].reverse());
    advisory(await inspect_live(backend,47,HEAD,mock.get,'synthetic-token'));
  });
  test(backend+': failed initial admission does not turn into authorization',async()=>{
    const f=fixture(backend);
    f.values[f.keys.jobs].jobs[0].steps=null;
    const mock=injected(f);
    blocked(await inspect_live(backend,47,HEAD,mock.get,'synthetic-token'));
  });
  const mutations=[
    ['PR head moved', (v,k)=>{v[k.pr].head.sha=OTHER;}],
    ['PR base moved', (v,k)=>{v[k.pr].base.sha=OTHER;}],
    ['PR author swapped', (v,k)=>{v[k.pr].user.login='ORESoftware';}],
    ['PR became draft', (v,k)=>{v[k.pr].draft=true;}],
    ['PR became unmergeable', (v,k)=>{v[k.pr].mergeable=false;}],
    ['PR closed', (v,k)=>{v[k.pr].state='closed';}],
    ['PR base repository changed', (v,k)=>{v[k.pr].base.repo.id+=1;}],
    ['PR head repository changed', (v,k)=>{v[k.pr].head.repo.id+=1;}],
    ['main commit moved', (v,k)=>{v[k.main].commit.sha=OTHER;}],
    ['main unprotected', (v,k)=>{v[k.main].protected=false;}],
    ['repository became public', (v,k)=>{v[k.repo].private=false;}],
    ['repository identity changed', (v,k)=>{v[k.repo].id+=1;}],
    ['repository archived', (v,k)=>{v[k.repo].archived=true;}],
    ['review dismissed', (v,k)=>{v[k.reviews][0].state='DISMISSED';}],
    ['review author changed', (v,k)=>{v[k.reviews][0].user.login='stranger';}],
    ['review commit changed', (v,k)=>{v[k.reviews][0].commit_id=OTHER;}],
    ['review timestamp changed', (v,k)=>{v[k.reviews][0].submitted_at='2026-11-07T20:01:00Z';}],
    ['review appended', (v,k)=>{v[k.reviews].push({id:402,user:{login:'ORESoftware'},
      state:'DISMISSED',commit_id:HEAD,submitted_at:'2026-11-07T20:01:00Z'});}],
    ['review page truncated', (v,k)=>{v[k.reviews]=[];}],
    ['run attempt advanced', (v,k)=>{v[k.runs].workflow_runs[0].run_attempt=3;}],
    ['run became failed', (v,k)=>{v[k.runs].workflow_runs[0].conclusion='failure';}],
    ['run SHA changed', (v,k)=>{v[k.runs].workflow_runs[0].head_sha=OTHER;}],
    ['run added to page', (v,k)=>{v[k.runs].total_count=2;
      v[k.runs].workflow_runs.push({...v[k.runs].workflow_runs[0],id:702});}],
    ['run removed from page', (v,k)=>{v[k.runs].total_count=0;
      v[k.runs].workflow_runs=[];}],
    ['run page total changed', (v,k)=>{v[k.runs].total_count=3;}],
    ['run page missing', (v,k)=>{v[k.runs]=null;}]
  ];
  for(const [name,mutate] of mutations) {
    test(backend+': deny postflight drift '+name,async()=>{
      const f=fixture(backend),mock=injected(f,mutate);
      await assert.rejects(inspect_live(backend,47,HEAD,mock.get,'synthetic-token'),
        /MERGE_DIAGNOSTIC_UNVERIFIED.*changed during collection/);
    });
  }
  test(backend+': deny second GET failure, do not accept a stale snapshot',async()=>{
    const f=fixture(backend),mock=injected(f,()=>{},f.keys.pr);
    await assert.rejects(inspect_live(backend,47,HEAD,mock.get,'synthetic-token'),
      /postflight GitHub read unavailable/);
  });
}
