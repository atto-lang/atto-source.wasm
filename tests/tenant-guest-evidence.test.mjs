import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verify_tenant_guest_evidence, unzip_evidence } from '../scripts/verify-tenant-guest-evidence.mjs';
import { REQUIRED_GUEST_CASES } from '../scripts/verify-tenant-guest-receipt.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const sha = 'a'.repeat(40), treeSha = 'b'.repeat(40), wf = Buffer.from('name: immutable tenant evidence\n');
const repo = 'ores-truffle-oreslang/oreslang-source.wasm';
const runid = 123456, artifactId = 777;

// Deliberately tiny STORE ZIP fixture; no external build tools or network needed.
function zip(files) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), d = Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    chunks.push(local, n, d);
    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6);
    ce.writeUInt32LE(d.length, 20); ce.writeUInt32LE(d.length, 24); ce.writeUInt16LE(n.length, 28);
    ce.writeUInt32LE(offset, 42); central.push(ce, n);
    offset += 30 + n.length + d.length;
  }
  const c = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, c, end]);
}
function fixture() {
  const source = Buffer.from('define actor TenantTest as end\n');
  const compiler = Buffer.from('atto-compiler-fixture');
  const guest = Buffer.from('compiled-wasm-guest-fixture');
  const cases = REQUIRED_GUEST_CASES.map(id => ({ id, execution: 'compiler-produced-guest', result: 'pass' }));
  const receipt = {
    backend: 'wasm', source_repo: repo, source_head_sha: sha,
    workflow: {source_head_sha:sha, run_id:runid, conclusion:'success',
      url:'https://github.com/' + repo + '/actions/runs/' + runid,
      jobs:[{conclusion:'success',steps:[{name:'execute compiled guest',conclusion:'success'}]}]},
    compiled_guest: {origin:'atto-source-compiler',source_sha256:hash(source),
      compiler_sha256:hash(compiler),binary_sha256:hash(guest), tenant_a:'tenant-a#1',tenant_b:'tenant-b#1'},
    cases
  };
  const execution = {origin:'atto-source-compiler',source_head_sha:sha,run_id:runid,
    compiler_sha256:hash(compiler),guest_sha256:hash(guest),tenant_a:'tenant-a#1',tenant_b:'tenant-b#1',cases};
  const archive = zip({'source.atto':source,'compiler.bin':compiler,'guest.bin':guest,
    'execution.json':Buffer.from(JSON.stringify(execution))});
  const policy = { source_repo:repo, source_head_sha:sha, workflow_path:'.github/workflows/tenant-evidence.yml',
    approved_workflow_sha256:hash(wf),workflow_id:333};
  const prefix = '/repos/' + repo + '/';
  const commonTree = {truncated:false,tree:[{type:'blob',path:'source.atto',sha:'c'.repeat(40),mode:'100644'}]};
  const routes = new Map([
    [prefix + 'commits/' + sha, {sha, commit:{tree:{sha:treeSha}}}],
    [prefix + 'actions/runs/' + runid, {id:runid,repository:{full_name:repo},conclusion:'success',status:'completed',
      workflow_id:333,path:policy.workflow_path+'@refs/heads/branch',head_sha:sha}],
    [prefix + 'git/trees/'+treeSha+'?recursive=1',commonTree],
    [prefix + 'contents/.github/workflows/tenant-evidence.yml?ref='+sha,
      {encoding:'base64',content:wf.toString('base64')}],
    [prefix + 'actions/runs/'+runid+'/jobs?per_page=100&page=1', {total_count:1,jobs:[{id:444,status:'completed',conclusion:'success',steps:[
      ...['Verify source blob parity','Compile AttoLang guest','Execute two-tenant guest'].map((name,i)=>({name,conclusion:'success',
        status:'completed',number:i+1,started_at:'2026-11-09T16:00:00Z',completed_at:'2026-11-09T16:01:00Z'}))]}]}],
    [prefix + 'actions/runs/'+runid+'/artifacts?per_page=100&page=1', {total_count:1,artifacts:[{
      id:artifactId,name:'tenant-guest-evidence',expired:false,workflow_run:{id:runid},
      digest:'sha256:'+hash(archive),size_in_bytes:archive.length}]}]
  ]);
  const io = {json:async path => {if(!routes.has(path))throw Error('unmocked '+path);return routes.get(path);},
    bytes:async path=>{assert.equal(path,prefix+'actions/artifacts/'+artifactId+'/zip');return archive;}};
  return { receipt, policy, io, routes, archive, prefix, source, compiler, guest, cases };
}
const verify = f => verify_tenant_guest_evidence(f.receipt,f.policy,f.io);
const denial = async (fn, match) => { const f=fixture(); fn(f);const out=await verify(f);
  assert.equal(out.evidence_status,'NOT_VERIFIED');assert.match(out.errors.join('\n'),match); };

test('corroborates exact-head run, vetted workflow, source blobs, and actual downloaded evidence', async()=>{
  const out=await verify(fixture());assert.equal(out.evidence_status,'PROVENANCE_CORROBORATED');
  assert.equal(out.enforcement_status,'NOT_VERIFIED');assert.equal(out.errors.length,0);
});
test('does not trust a receipt-provided source SHA without protected policy', async()=>{
  await denial(f=>{f.policy.source_head_sha='f'.repeat(40)},/trusted policy/);
});
test('requires an approved workflow digest', async()=>{
  await denial(f=>{f.policy.approved_workflow_sha256='unknown'},/approved workflow digest/);
});
test('rejects false workflow conclusions despite successful submitted JSON', async()=>{
  await denial(f=>{f.routes.get(f.prefix+'actions/runs/'+runid).conclusion='failure'},/successful completion/);
});
test('rejects a run at the wrong head', async()=>{
  await denial(f=>{f.routes.get(f.prefix+'actions/runs/'+runid).head_sha='f'.repeat(40)},/not approved exact carrier commit/);
});
test('rejects a changed workflow body', async()=>{
  await denial(f=>{f.routes.get(f.prefix+'contents/.github/workflows/tenant-evidence.yml?ref='+sha).content=Buffer.from('unreviewed').toString('base64')},/workflow byte identity/);
});
test('rejects zero-step jobs even when job claims success', async()=>{
  await denial(f=>{f.routes.get(f.prefix+'actions/runs/'+runid+'/jobs?per_page=100&page=1').jobs[0].steps=[]},/job steps are absent/);
});
test('rejects missing execution step', async()=>{
  await denial(f=>{f.routes.get(f.prefix+'actions/runs/'+runid+'/jobs?per_page=100&page=1').jobs[0].steps.pop()},/job steps are absent/);
});
test('rejects incomplete paginated job evidence', async()=>{
  await denial(f=>{f.routes.get(f.prefix+'actions/runs/'+runid+'/jobs?per_page=100&page=1').total_count=101},/paginated/);
});
test('rejects artifact bytes that differ from GitHub archive digest', async()=>{
  await denial(f=>{f.io.bytes=async()=>Buffer.from('different zip')},/artifact byte digest/);
});
test('rejects compiler artifact bytes not matching receipt compiler digest', async()=>{
  await denial(f=>{f.receipt.compiled_guest.compiler_sha256='f'.repeat(64)},/artifact digest mismatch/);
});
test('rejects missing required case from execution artifact', async()=>{
  await denial(f=>{const archive=zip({'source.atto':f.source,'compiler.bin':f.compiler,'guest.bin':f.guest,
    'execution.json':JSON.stringify({...JSON.parse(unzip_evidence(f.archive).get('execution.json')),cases:f.cases.slice(1)})});
    f.io.bytes=async()=>archive;
    const a=f.routes.get(f.prefix+'actions/runs/'+runid+'/artifacts?per_page=100&page=1').artifacts[0];a.digest='sha256:'+hash(archive);a.size_in_bytes=archive.length;
  },/mandatory guest case evidence/);
});
test('rejects unapproved private carrier', async()=>{
  await denial(f=>{f.receipt.workflow.carrier_repo='benefactor-cc/temporary';f.receipt.workflow.verified_blob_count=1;f.receipt.workflow.blob_mismatches=0},/carrier is not explicitly approved/);
});
test('rejects mutated carrier Git blobs', async()=>{
  await denial(f=>{f.policy.carrier_repo='benefactor-cc/temporary';f.policy.carrier_head_sha='d'.repeat(40);
    f.receipt.workflow.carrier_repo='benefactor-cc/temporary';f.receipt.workflow.verified_blob_count=1;f.receipt.workflow.blob_mismatches=0;
    const pref='/repos/benefactor-cc/temporary/';
    f.routes.set(pref+'actions/runs/'+runid,{...f.routes.get(f.prefix+'actions/runs/'+runid),
      repository:{full_name:'benefactor-cc/temporary'},head_sha:f.policy.carrier_head_sha});
    f.routes.set(pref+'commits/'+f.policy.carrier_head_sha,{sha:f.policy.carrier_head_sha,commit:{tree:{sha:treeSha}}});
    f.routes.set(pref+'git/trees/'+treeSha+'?recursive=1',{truncated:false,tree:[{type:'blob',path:'source.atto',sha:'f'.repeat(40),mode:'100644'}]});
  },/source\/carrier blob parity mismatch/);
});
test('rejects path traversal in downloaded ZIP',()=>{
  assert.throws(()=>unzip_evidence(zip({'../escape':Buffer.from('no')})),/unsafe or duplicate/);
});
test('rejects corrupted ZIP end directory',()=>{
  const a=zip({'guest.bin':Buffer.from('test')}); a[a.length-22]=0x00;
  assert.throws(()=>unzip_evidence(a),/valid end directory/);
});
