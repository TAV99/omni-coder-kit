'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const api=()=>{assert.ok(fs.existsSync(path.join(__dirname,'squad-acceptance.js')));return require('./squad-acceptance');};
function temp(t){const p=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'acceptance-harness-')));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('source snapshots capture edits to already-dirty files, deletions, new paths and symlinks without following them',t=>{
 const {snapshotSource,changedFiles}=api(),root=temp(t);
 execFileSync('git',['init','-q'],{cwd:root});fs.writeFileSync(path.join(root,'tracked.js'),'v1');execFileSync('git',['add','tracked.js'],{cwd:root});
 fs.writeFileSync(path.join(root,'tracked.js'),'dirty');fs.writeFileSync(path.join(root,'deleted.js'),'old');
 const before=snapshotSource(root);fs.writeFileSync(path.join(root,'tracked.js'),'integrated');fs.unlinkSync(path.join(root,'deleted.js'));fs.writeFileSync(path.join(root,'new.js'),'new');
 fs.symlinkSync('/outside/never-read',path.join(root,'link'));
 assert.deepEqual(changedFiles(before,snapshotSource(root)),['deleted.js','link','new.js','tracked.js']);
});
test('finance source appears only in sourced T08 context replies and other tasks repeat public contract',()=>{
 const {sourceContextBody}=api();const input={questionId:'q1',planRevision:1};
 const body=sourceContextBody({...input,task:{task_id:'T08',goal:'export CSV'}});
 assert.match(body,/book_id,title,amount/);assert.match(body,/Question ID: q1/);assert.match(body,/finance-format.md/);
 assert.doesNotMatch(sourceContextBody({...input,task:{task_id:'T01',goal:'case-insensitive'}}),/book_id|finance-format/);
});
function fake(t,{auto=false,driveError=false,delegateApprovals=false}={}){
 const {runAcceptance}=api(),container=temp(t),root=path.join(container,'workspace'),outDir=path.join(container,'report');fs.mkdirSync(root);execFileSync('git',['init','-q'],{cwd:root});const trace=[];
 const state={sessionId:'s',workspaceId:'w',planRevision:1,lastSequence:1,tasks:{T01:{state:'TASK_VERIFIED'}},leases:{},approvals:{'plan-r1':{gate_id:'plan-r1',phase:'plan',status:'approved',actor:auto?'auto':'human',via:auto?'pipeline-auto':'cli-tty'}}};
 const events=[{sequence:1,type:'session.started',timestamp:new Date().toISOString()}];
 const daemon={client:{beginSession:async()=>({session_id:'s'}),registerPlan:async()=>({registered:true}),resumeSession:async()=>({})},authority:{derive:()=>structuredClone(state),readEvents:()=>structuredClone(events)},waitUntilReady:async()=>{},stop:async()=>{trace.push('daemon-stop');}};
 const deps={
  prepare:async opts=>{opts.onCreated({root,container,home:container});return {root,container,tasks:[{task_id:'T01',goal:'test',allowed_files:['x']}],config:'A',binding:{roles:{}},setup:{engine:{supported:true}},planSha256:'a'.repeat(64),baselineCommit:'abc',suiteVersion:1};},
  startUi:async opts=>{assert.equal(opts.autoStart,false);return {url:'http://127.0.0.1:1234/#token=private-ui',token:'private-ui',close:async()=>trace.push('ui-stop')};},
  startDaemon:()=>daemon,
  drive:async()=>{trace.push('drive');if(driveError)throw Object.assign(new Error('private@example.com token=private-error'),{code:'BROKEN'});return {complete:true,frontiers:[['integrate-T01']]};},
  hidden:async()=>{assert.ok(trace.includes('daemon-stop'));trace.push('hidden');return {T01:{passed:true,exitCode:0}};},
  collect:()=>({complete:true,problems:[],turns:[],runtimeFailures:[]}),
  archive:async()=>{assert.ok(trace.includes('daemon-stop'));trace.push('archive');return {archives:[],transcripts:[],problems:[]};},
  measure:input=>{assert.equal(input.snapshot.lastSequence,1);return {passed:false,thresholdsPassed:true,completeSuite:false,taskResults:[],thresholds:{requirements:{passed:true}}};},
  gatePolicy:()=>({gated:true,autoOk:true}),log:()=>{},
 };
 return {run:()=>runAcceptance({outDir,config:'A',taskIds:['T01'],auto,delegateApprovals},deps),trace,outDir,root,state,deps};
}

test('explicit delegation starts the acceptance wrapper and accepts test provenance without a TTY prompt',async t=>{
 const f=fake(t,{delegateApprovals:true});
 const delegation={protocol:'benchmark-delegation-v1',id:'unit',artifactSha256:'b'.repeat(64),planRevision:1,planSha256:'a'.repeat(64),taskIds:['T01'],createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
 const file=path.join(path.dirname(f.root),'delegation.json');fs.writeFileSync(file,'{}');
 const hash=require('node:crypto').createHash('sha256').update('{}').digest('hex');
 f.deps.createDelegation=()=>({path:file,sha256:hash});f.deps.loadDelegation=()=>delegation;
 Object.assign(f.state.approvals['plan-r1'],{actor:'test',via:'test-harness',digest:delegation.planSha256,decided_at:new Date().toISOString()});
 const start=f.deps.startDaemon;
 f.deps.startDaemon=opts=>{assert.match(opts.entryPoint,/acceptance-daemon\.js$/);assert.deepEqual(opts.argvPrefix,['--delegation',file,'--sha256',hash]);return start();};
 const report=await f.run();assert.equal(report.errorCode,null);assert.equal(report.approvalMode,'delegated-benchmark');
 assert.equal(report.delegation.id,'unit');
});

test('T04 supplement rejects permissive missing args, falsey empty rejection and whitespace trimming', t=>{
 const {runSearchContractCheck}=api(),container=temp(t),root=path.join(container,'workspace');
 fs.mkdirSync(path.join(root,'bin'),{recursive:true});
 const cli=path.join(root,'bin/cli.js');
 // Fixed response witnesses isolate the validator from the bookshelf implementation.
 const stub="const q=process.argv[3];if(q==='--file'){process.stderr.write('Query required\\n');process.exitCode=1;}else{const ids=q===''?['plain','one','three']:q===' '?['one','three']:q==='   '?['three']:[];process.stdout.write(ids.map(id=>id+' | row\\n').join(''));}";
 for(const [name,code,passed] of [
  ['permissive',"process.stdout.write('');",false],
  ['empty-rejected',stub.replace("q==='--file'","!q||q==='--file'"),false],
  ['trimmed',stub.replace('q=process.argv[3]','q=process.argv[3].trim()'),false],
  ['correct',stub,true],
 ]){const privateDir=path.join(container,name);fs.mkdirSync(privateDir);fs.writeFileSync(cli,code);
  const result=runSearchContractCheck({root,privateDir,deadline:Date.now()+5000});assert.equal(result.passed,passed,name);
 }
});
test('partial harness run stops the daemon before hidden tests and archives before its sanitized final report',async t=>{
 const f=fake(t),report=await f.run();
 assert.equal(report.ok,false);assert.equal(report.partial,true);assert.equal(report.selectedPassed,true);
 assert.deepEqual(f.trace,['drive','daemon-stop','hidden','archive','ui-stop']);
 const saved=fs.readFileSync(path.join(f.outDir,'report.json'),'utf8');assert.doesNotMatch(saved,/private-ui|private@example/);
});
test('initial acceptance resume requests ACK instead of unrelated task history',async t=>{
 const f=fake(t),daemon=f.deps.startDaemon();let calls=0;
 daemon.client.resumeSession=async params=>{calls++;if(params.projection!=='ack')throw Object.assign(new Error('large history'),{code:'DUAL_CLIENT_RESPONSE_TOO_LARGE'});assert.equal(params.session_id,'s');return {session_id:'s',resumed:true};};
 assert.equal((await f.run()).errorCode,null);assert.equal(calls,1);
});
test('failure preserves the workspace, collects evidence, closes UI and never releases hidden tests',async t=>{
 const f=fake(t,{driveError:true}),report=await f.run();
 assert.equal(report.ok,false);assert.equal(report.errorCode,'BROKEN');assert.ok(fs.existsSync(f.root));
 assert.deepEqual(f.trace,['drive','daemon-stop','archive','ui-stop']);
 assert.doesNotMatch(fs.readFileSync(path.join(f.outDir,'report.md'),'utf8'),/private@example.com|private-error/);
});
test('explicit AUTO accepts only the expected pipeline-auto plan decision',async t=>{
 const f=fake(t,{auto:true});assert.equal((await f.run()).errorCode,null);
 const g=fake(t,{auto:false});g.state.approvals['plan-r1'].actor='auto';g.state.approvals['plan-r1'].via='pipeline-auto';
 assert.equal((await g.run()).errorCode,'GATE_NOT_HUMAN');assert.ok(!g.trace.includes('drive'));
});
test('failed setup records the callback workspace and retains it with an incomplete report',async t=>{
 const f=fake(t);f.deps.prepare=async opts=>{opts.onCreated({root:f.root,container:path.dirname(f.root)});throw Object.assign(new Error('failed probe'),{code:'PROBE'});};
 const report=await f.run();assert.equal(report.errorCode,'PROBE');assert.equal(report.workspaceRoot,f.root);assert.ok(fs.existsSync(f.root));
});
test('an existing nonempty output is refused before setup and never overwritten',async t=>{
 const f=fake(t);fs.mkdirSync(f.outDir);fs.writeFileSync(path.join(f.outDir,'keep'),'original');
 await assert.rejects(f.run(),{code:'ACCEPTANCE_OUTPUT_EXISTS'});assert.equal(fs.readFileSync(path.join(f.outDir,'keep'),'utf8'),'original');
});

test('source snapshot permits deletion of an entire tracked directory',t=>{
 const {snapshotSource,changedFiles}=api(),root=temp(t);execFileSync('git',['init','-q'],{cwd:root});
 fs.mkdirSync(path.join(root,'nested'));fs.writeFileSync(path.join(root,'nested/a'),'old');execFileSync('git',['add','.'],{cwd:root});
 const before=snapshotSource(root);fs.rmSync(path.join(root,'nested'),{recursive:true});
 assert.deepEqual(changedFiles(before,snapshotSource(root)),['nested/a']);
});

test('real hidden runner fails on baseline and passes a reference solution, recording actual executed tests',async t=>{
 const {runHiddenTests}=api(),container=temp(t),root=path.join(container,'workspace'),privateDir=path.join(container,'private');
 fs.cpSync(path.join(__dirname,'fixtures/acceptance/bookshelf'),root,{recursive:true});fs.mkdirSync(privateDir);
 const baseline=await runHiddenTests({root,privateDir,taskIds:['T01'],deadline:Date.now()+20000});
 assert.equal(baseline.T01.passed,false);assert.notEqual(baseline.T01.exitCode,0);
 assert.match(fs.readFileSync(path.join(privateDir,'hidden-T01.log'),'utf8'),/(?:tests [1-9]|[1-9] tests)/);
 fs.rmSync(path.join(root,'hidden'),{recursive:true});fs.unlinkSync(path.join(privateDir,'hidden-T01.log'));
 execFileSync('git',['apply',path.join(__dirname,'fixtures/acceptance/reference/T01.patch')],{cwd:root});
 const fixed=await runHiddenTests({root,privateDir,taskIds:['T01'],deadline:Date.now()+20000});
 assert.equal(fixed.T01.passed,true);
});

test('an interrupted run still preserves evidence and refuses hidden release',async t=>{
 const f=fake(t),controller=new AbortController();f.deps.signal=controller.signal;
 f.deps.drive=async opts=>{controller.abort();await opts.beforeCheck();};
 const report=await f.run();assert.equal(report.errorCode,'ACCEPTANCE_INTERRUPTED');assert.ok(f.trace.includes('archive'));assert.ok(!f.trace.includes('hidden'));
});

test('snapshot retries a concurrent authority append and rejects unstable snapshots',()=>{
 const {coherentAuthoritySnapshot}=api();let count=0;
 const authority={derive:()=>({sessionId:'s',workspaceId:'w',planRevision:1,lastSequence:++count}),readEvents:()=>[{sequence:2}]};
 assert.equal(coherentAuthoritySnapshot(authority).snapshot.lastSequence,2);
 assert.throws(()=>coherentAuthoritySnapshot({derive:()=>({lastSequence:1}),readEvents:()=>[{sequence:2}]}),{code:'ACCEPTANCE_SNAPSHOT_UNSTABLE'});
});

test('source drift during a long worker operation stops the daemon and withholds hidden tests',async t=>{
 const f=fake(t);
 f.deps.drive=async opts=>{
  fs.writeFileSync(path.join(f.root,'unauthorized.js'),'source changed outside integration');
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.ok(f.trace.includes('daemon-stop'),'periodic observer must stop the daemon before the operation returns');
  opts.beforeCheck();
  return {complete:true};
 };
 const report=await f.run();
 assert.equal(report.errorCode,'ACCEPTANCE_SOURCE_DRIFT');assert.equal(report.ok,false);
 assert.equal(report.sourceIntegrity.passed,false);
 assert.deepEqual(report.sourceIntegrity.violations[0].changed_files,['unauthorized.js']);
 assert.ok(!f.trace.includes('hidden'));
 assert.equal(fs.readFileSync(path.join(f.root,'unauthorized.js'),'utf8'),'source changed outside integration');
});

test('a source reset by initial resume is caught before entering worker drive',async t=>{
 const f=fake(t);
 f.deps.startDaemon().client.resumeSession=async()=>{fs.writeFileSync(path.join(f.root,'unexpected.js'),'bad');return {};};
 const report=await f.run();
 assert.equal(report.errorCode,'ACCEPTANCE_SOURCE_DRIFT');
 assert.ok(!f.trace.includes('drive'));assert.ok(!f.trace.includes('hidden'));
});

test('P7 services a six-question batch as one context round and reports exact acknowledged IDs',async t=>{
 const f=fake(t),client=f.deps.startDaemon().client;
 client.replyToTask=async()=>({acknowledged:true});client.request=async()=>({resumed:true});
 f.deps.drive=async opts=>{await opts.serviceContext({taskId:'T01',task:{waitingContext:{question_ids:Array.from({length:6},(_,i)=>'q'+i)}},remainingMs:1000});return {complete:true};};
 const report=await f.run();assert.equal(report.errorCode,null);assert.equal(report.contextByTask.T01.length,6);
 assert.equal(report.contextRoundBudget.T01.count,1);assert.equal(report.contextRoundBudget.T01.history[0].complete,true);
});
