import test from 'node:test';
import assert from 'node:assert/strict';
import {REPOS, assess} from '../scripts/merge_readiness_probe_20261106.mjs';

// Source-only adversarial gate, not a successful GitHub job or a guest test.
const HEAD = 'e'.repeat(40);
function fixture(backend) {
  const [slug,id] = REPOS[backend];
  return {
    repo: {id, full_name:slug, private:true, archived:false, disabled:false},
    main: {name:'main', protected:true},
    pr: {number:51, state:'open', draft:false, mergeable:true,
      base:{ref:'main',repo:{id}}, head:{sha:HEAD,repo:{id}},
      user:{login:'the1mills'}},
    reviews:[{user:{login:'ORESoftware'},state:'APPROVED',commit_id:HEAD}],
    runs:[{run:{id:101,head_sha:HEAD,event:'pull_request',status:'completed',
      conclusion:'success',run_attempt:2,repository:{id},head_repository:{id}},
      jobs:[{id:201,run_id:101,head_sha:HEAD,run_attempt:2,
        status:'completed',conclusion:'success',runner_id:55,
        runner_name:'GitHub Actions 55',name:'test',steps:[
          {name:'Set up job',status:'completed',conclusion:'success'},
          {name:'Execute native tests',status:'completed',conclusion:'success'}]}]}]
  };
}
function verdict(backend, mutate) {
  const x=fixture(backend); mutate(x);
  return assess(x,backend,51,HEAD);
}
function blocked(result, reason) {
  assert.equal(result.decision,'BLOCKED',reason);
  assert.ok(result.failures.length>0,reason);
  assert.equal(result.merge_authorized,false);
  assert.equal(result.private_source_export_authorized,false);
  assert.equal(result.guest_parity_certified,false);
}
function advisory(result) {
  assert.equal(result.decision,'REQUIRES_INDEPENDENT_RELEASE_REVIEW');
  assert.deepEqual(result.failures,[]);
  assert.equal(result.merge_authorized,false);
  assert.equal(result.private_source_export_authorized,false);
  assert.equal(result.guest_parity_certified,false);
}
function cloneJob(job,id,name) {return {...job,id,name,steps:job.steps.map(s=>({...s}))};}
for(const backend of Object.keys(REPOS)) {
  test(backend+': unique successful job names remain advisory only',()=>{
    advisory(verdict(backend,f=>{
      f.runs[0].jobs.push(cloneJob(f.runs[0].jobs[0],202,'native-guest'));
    }));
  });
  test(backend+': identical job names from different run IDs are allowed',()=>{
    advisory(verdict(backend,f=>{
      const first=f.runs[0];
      f.runs.push({run:{...first.run,id:102},
        jobs:[cloneJob(first.jobs[0],202,'test')]});
      f.runs[1].jobs[0].run_id=102;
    }));
  });
  test(backend+': deny same-name jobs with distinct job IDs',()=>{
    blocked(verdict(backend,f=>{
      f.runs[0].jobs.push(cloneJob(f.runs[0].jobs[0],202,'test'));
    }),'duplicate same-name job');
  });
  test(backend+': deny case-insensitive duplicate job names',()=>{
    blocked(verdict(backend,f=>{
      f.runs[0].jobs.push(cloneJob(f.runs[0].jobs[0],202,'TEST'));
    }),'duplicate casefolded job');
  });
  for(const hook of ['Pre-checkout','Post-checkout','Pre: checkout','Post: cleanup','Pre_setup','post_cleanup']) {
    test(backend+': deny housekeeping-only '+hook,()=>{
      blocked(verdict(backend,f=>{
        f.runs[0].jobs[0].steps=[{name:hook,status:'completed',conclusion:'success'}];
      }),'housekeeping disguise');
    });
  }
  test(backend+': a substantive step after pre/post housekeeping remains advisory',()=>{
    advisory(verdict(backend,f=>{
      f.runs[0].jobs[0].steps=[
        {name:'Pre-checkout',status:'completed',conclusion:'success'},
        {name:'Run exact-head tests',status:'completed',conclusion:'success'},
        {name:'Post-checkout',status:'completed',conclusion:'success'}];
    }));
  });
  test(backend+': still reject zero-step runner admission',()=>{
    blocked(verdict(backend,f=>{f.runs[0].jobs[0].steps=[];}),'empty steps');
  });
  test(backend+': still reject null-step runner admission',()=>{
    blocked(verdict(backend,f=>{f.runs[0].jobs[0].steps=null;}),'null steps');
  });
}
