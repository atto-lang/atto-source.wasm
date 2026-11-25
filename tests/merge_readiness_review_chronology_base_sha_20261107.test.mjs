import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REPOS, assess} from '../scripts/merge_readiness_probe_20261106.mjs';

// These are synthetic, advisory readiness snapshots, NOT live GitHub
// review/runner receipts or compiler-backed guest execution.
const HEAD='a'.repeat(40), BASE='b'.repeat(40), OTHER='c'.repeat(40);
const T0='2026-11-07T20:00:00Z', T1='2026-11-07T20:01:00Z', T2='2026-11-07T20:02:00Z';
function fx(backend) {
  const [full_name,id]=REPOS[backend];
  return {
    repo:{id,full_name,private:true,archived:false,disabled:false},
    main:{name:'main',protected:true,commit:{sha:BASE}},
    pr:{number:47,state:'open',draft:false,mergeable:true,
      base:{ref:'main',repo:{id},sha:BASE},head:{repo:{id},sha:HEAD},
      user:{login:'the1mills'}},
    reviews:[{id:401,user:{login:'ORESoftware'},state:'APPROVED',
      commit_id:HEAD,submitted_at:T0}],
    runs:[{run:{id:701,head_sha:HEAD,event:'pull_request',
      status:'completed',conclusion:'success',run_attempt:2,
      repository:{id},head_repository:{id}},
      jobs:[{id:801,run_id:701,head_sha:HEAD,run_attempt:2,
        status:'completed',conclusion:'success',runner_id:90,
        runner_name:'GitHub Actions 90',name:'Native guest conformance',
        steps:[{name:'Set up job',status:'completed',conclusion:'success'},
          {name:'Run real native guest',status:'completed',conclusion:'success'}]}]}],
  };
}
const review=(id,state,submitted_at,login='ORESoftware',commit_id=HEAD)=>
  ({id,user:{login},state,submitted_at,commit_id});
function verdict(b,modify) {const f=fx(b);modify(f);return assess(f,b,47,HEAD);}
function blocked(r,name) {
  assert.equal(r.decision,'BLOCKED',name);
  assert.ok(r.failures.length>0,name);
  assert.equal(r.merge_authorized,false);
  assert.equal(r.private_source_export_authorized,false);
  assert.equal(r.guest_parity_certified,false);
}
function advisory(r) {
  assert.equal(r.decision,'REQUIRES_INDEPENDENT_RELEASE_REVIEW');
  assert.deepEqual(r.failures,[]);
  assert.equal(r.merge_authorized,false);
  assert.equal(r.private_source_export_authorized,false);
  assert.equal(r.guest_parity_certified,false);
}
for(const backend of Object.keys(REPOS)) {
  const positives=[
    ['same main base, single approved review',()=>{}],
    ['reordered older dismissed then latest approval',f=>{
      f.reviews=[review(403,'APPROVED',T2),review(401,'DISMISSED',T0)];
    }],
    ['older changes request followed by new approval',f=>{
      f.reviews=[review(403,'APPROVED',T2),review(401,'CHANGES_REQUESTED',T0)];
    }],
    ['same timestamp resolved by higher review ID',f=>{
      f.reviews=[review(403,'APPROVED',T0),review(401,'DISMISSED',T0)];
    }],
    ['submitted COMMENTED does not revoke approval',f=>{
      f.reviews.unshift(review(403,'COMMENTED',T2));
    }],
    ['pending unsubmitted review does not revoke approval',f=>{
      f.reviews.unshift(review(403,'PENDING',null));
    }],
  ];
  for(const [label,mutate] of positives)
    test(backend+': advisory '+label,()=>advisory(verdict(backend,mutate)));
  const negatives=[
    ['later dismissed despite reversed array',f=>{
      f.reviews=[review(403,'DISMISSED',T2),review(401,'APPROVED',T0)];
    }],
    ['later changes requested despite reversed array',f=>{
      f.reviews=[review(403,'CHANGES_REQUESTED',T2),review(401,'APPROVED',T0)];
    }],
    ['latest approval stale despite earlier current approval',f=>{
      f.reviews=[review(403,'APPROVED',T2,'ORESoftware',OTHER),review(401,'APPROVED',T0)];
    }],
    ['duplicate review ID same account',f=>{
      f.reviews.push(review(401,'APPROVED',T1));
    }],
    ['duplicate review ID different account',f=>{
      f.reviews.push(review(401,'COMMENTED',T1,'observer'));
    }],
    ['review ID absent',f=>{delete f.reviews[0].id;}],
    ['review ID zero',f=>{f.reviews[0].id=0;}],
    ['review ID fractional',f=>{f.reviews[0].id=1.5;}],
    ['review ID negative',f=>{f.reviews[0].id=-1;}],
    ['review ID string',f=>{f.reviews[0].id='401';}],
    ['review ID not safe integer',f=>{f.reviews[0].id=Number.MAX_SAFE_INTEGER+1;}],
    ['review timestamp absent',f=>{delete f.reviews[0].submitted_at;}],
    ['review timestamp malformed',f=>{f.reviews[0].submitted_at='yesterday';}],
    ['review timestamp impossible date',f=>{f.reviews[0].submitted_at='2026-02-30T20:00:00Z';}],
    ['review timestamp non-UTC',f=>{f.reviews[0].submitted_at='2026-11-07T20:00:00-05:00';}],
    ['review timestamp future year malformed',f=>{f.reviews[0].submitted_at='20999-11-07T20:00:00Z';}],
    ['review state unknown',f=>{f.reviews[0].state='CANCELLED';}],
    ['review state lowercase',f=>{f.reviews[0].state='approved';}],
    ['review timestamp/id chronological contradiction',f=>{
      f.reviews.push(review(403,'DISMISSED',T0));
    }],
    ['review timestamp/id reverse contradiction',f=>{
      f.reviews.push(review(399,'DISMISSED',T2));
    }],
    ['both main and base SHAs omitted',f=>{
      delete f.main.commit;delete f.pr.base.sha;
    }],
    ['main commit missing',f=>{delete f.main.commit;}],
    ['main SHA empty',f=>{f.main.commit.sha='';}],
    ['main SHA malformed',f=>{f.main.commit.sha='not-a-sha';}],
    ['main SHA only 39 digits',f=>{f.main.commit.sha='b'.repeat(39);}],
    ['PR base SHA missing',f=>{delete f.pr.base.sha;}],
    ['PR base SHA differs from main',f=>{f.pr.base.sha=OTHER;}],
    ['main changed after PR snapshot',f=>{f.main.commit.sha=OTHER;}],
    ['base same as head but differs from main',f=>{f.pr.base.sha=HEAD;}],
    ['unprotected main',f=>{f.main.protected=false;}],
    ['moved PR head',f=>{f.pr.head.sha=OTHER;}],
    ['zero-step CI despite valid review',f=>{f.runs[0].jobs[0].steps=null;}],
    ['wrong run attempt',f=>{f.runs[0].jobs[0].run_attempt=1;}],
    ['failed real guest step',f=>{f.runs[0].jobs[0].steps[1].conclusion='failure';}],
  ];
  for(const [label,mutate] of negatives)
    test(backend+': blocked '+label,()=>blocked(verdict(backend,mutate),label));
}
