'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = () => { assert.ok(fs.existsSync(path.join(__dirname,'helpers/acceptance-archive.js'))); return require('./helpers/acceptance-archive'); };
function fixture(t) {
    const container = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'acceptance-archive-')));
    t.after(()=>fs.rmSync(container,{recursive:true,force:true}));
    const root = path.join(container,'workspace'), outDir = path.join(container,'out'), captureDir=path.join(container,'capture'), daemonLog=path.join(container,'daemon.log');
    for (const dir of ['dual-authority','dual-discussion','dual-workspaces']) fs.mkdirSync(path.join(root,'.omni/runs',dir),{recursive:true});
    fs.mkdirSync(captureDir);fs.writeFileSync(path.join(captureDir,'raw.json'),'secret raw');
    fs.writeFileSync(daemonLog,'raw log'); fs.writeFileSync(path.join(root,'.omni/runs/dual-authority/events.ndjson'),'raw ledger\n');
    return {container,root,outDir,captureDir,daemonLog};
}
test('archives byte-identical run trees privately and only queries exact attributable transcript sessions',async t=>{
    const { archiveAcceptanceEvidence }=api(), f=fixture(t), calls=[];
    const native=path.join(f.container,'native.jsonl');fs.writeFileSync(native,'raw transcript\n');
    const registry={get:()=>({readTranscript:async ref=>{calls.push(ref);return {found:true,sessionId:ref.sessionId,file:native};}})};
    const result=await archiveAcceptanceEvidence({...f,registry,turns:[
        {runtime:'codex',sessionRef:'session-1',cwd:f.root,startedAt:'2026-11-02T00:00:00Z'},
        {runtime:'codex',sessionRef:'session-1',cwd:f.root},
        {runtime:'codex',sessionRef:'foreign',cwd:path.dirname(f.container)},
    ]});
    assert.equal(calls.length,1);assert.equal(calls[0].sessionId,'session-1');
    assert.equal(result.transcripts.filter(x=>x.status==='copied').length,1);
    assert.equal(fs.readFileSync(path.join(f.outDir,'private/authority/events.ndjson'),'utf8'),'raw ledger\n');
    assert.equal(fs.readFileSync(path.join(f.outDir,'private/transcripts/0.jsonl'),'utf8'),'raw transcript\n');
    assert.ok(result.problems.some(x=>x.code==='TRANSCRIPT_CWD_OUTSIDE_RUN'));
    if(process.platform!=='win32') assert.equal(fs.statSync(path.join(f.outDir,'private/transcripts/0.jsonl')).mode&0o777,0o600);
});
test('mismatched transcript identities and symlink trees cannot copy external evidence',async t=>{
    const { archiveAcceptanceEvidence }=api(),f=fixture(t);
    const native=path.join(f.container,'native');fs.writeFileSync(native,'never copy');
    fs.symlinkSync(native,path.join(f.root,'.omni/runs/dual-workspaces/escape'));
    const registry={get:()=>({readTranscript:async()=>({found:true,sessionId:'wrong',file:native})})};
    const result=await archiveAcceptanceEvidence({...f,registry,turns:[{runtime:'claude',sessionRef:'right',cwd:f.root}]});
    assert.ok(result.problems.some(x=>x.code==='TRANSCRIPT_IDENTITY_MISMATCH'));
    assert.ok(result.problems.some(x=>x.code==='ACCEPTANCE_EVIDENCE_SYMLINK'));
    assert.ok(!fs.existsSync(path.join(f.outDir,'private/transcripts/0.jsonl')));
});
test('unsupported and unavailable transcripts are explicitly recorded without broad discovery',async t=>{
    const { archiveAcceptanceEvidence }=api(),f=fixture(t);
    const result=await archiveAcceptanceEvidence({...f,registry:{get:()=>({})},turns:[{runtime:'agy',sessionRef:'x',cwd:f.root},{runtime:'codex',cwd:f.root}]});
    assert.deepEqual(result.transcripts.map(x=>x.status),['unsupported','no-session-reference']);
});
