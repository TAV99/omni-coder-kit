'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandCatalog, validateArtifact, evaluateGate, validateDecisionLog, validateValue, digest, CoverageStore, inspectWorkspaceCoverage } = require('../lib/dual/spec-coverage');
const source = [{ kind: 'user', ref: 'user-request:initial' }];
function candidate() {
    return { schema_version: 1, catalog_version: 1, revision: 1, app_types: ['booking'], classification_sources: ['user-request:initial'], dimensions: expandCatalog(['booking']).map(d => ({ id: d.id, state: 'unresolved', sources: [], proposal: d.examples?.[0] })) };
}
function pinned() { const a = candidate(); a.dimensions = a.dimensions.map(d => ({ id: d.id, state: 'pinned', value: expandCatalog(['booking']).find(x => x.id === d.id).examples[0], sources: source })); return a; }
function plan(artifact) { return { schema_version: 2, plan_revision: 1, acceptance_policy: {protocol_version:1,checks:[{id:'accept-1',requirement_id:'requirement-1',phase:'session',kind:'command',required:true,command:{program:'node',args:['--version'],cwd:'.'}}]}, coverage: { path: '.omni/sdlc/spec-coverage.json', sha256: digest(JSON.stringify(artifact)), catalog_version: 1 }, tasks: [{ task_id: 'BOOK-1', title:'Booking', owner:'agy',goal:'Implement booking',category:'frontend',complexity:'medium',risk:'low',allowed_files:['src/booking.js'],context_files:[],deny_patterns:[],validation_commands:[{program:'node',args:['--version'],cwd:'.'}], decision_ids: artifact.dimensions.map(d => d.id) }] }; }
function receipt(artifact, p) { return { request_id: 'approve-1', actor: 'user', source: 'user-message:1', timestamp: new Date().toISOString(), catalog_version: 1, coverage_digest: digest(artifact), plan_revision: p.plan_revision, task_ids: ['BOOK-1'], baseline: 'a'.repeat(40) }; }
function request(a, decisions) { return { request_id: 'approve-1', actor: 'user', source: 'user-message:1', session_id: 'session-1', workspace: 'workspace-1', candidate_digest: digest(a), plan_revision: 1, decisions }; }
describe('decision coverage catalog and artifact', () => {
    it('expands every independent core and booking decision', () => {
        const ids = expandCatalog(['booking']).map(d => d.id);
        assert.equal(ids.length, 23);
        for (const id of ['actions.create','actions.read','actions.edit','actions.delete','actions.cancel','actions.date_filter','booking.hours','booking.slots','booking.capacity','booking.date_policy','booking.services','booking.cancel_policy']) assert.ok(ids.includes(id));
        assert.ok(expandCatalog(['booking']).find(d => d.id === 'booking.slots').value_schema.required.includes('step_minutes'));
    });
    it('rejects unknown type/version', () => { assert.throws(() => expandCatalog(['commerce']), /Unsupported app type/); assert.throws(() => expandCatalog(['booking'], 2), /Unsupported catalog/); });
    it('proposals do not count and missing or duplicate IDs fail', () => {
        const a = candidate(); assert.equal(validateArtifact(a).pending_ids.length, 23); assert.equal(validateArtifact(a).valid, true);
        a.dimensions.push(a.dimensions[0]); assert.equal(validateArtifact(a).valid, false);
        a.dimensions = a.dimensions.slice(1, -1); assert.equal(validateArtifact(a).valid, false);
    });
    it('accepts valid values, rejects incomplete action and slot values', () => {
        const a = pinned(); assert.equal(validateArtifact(a).valid, true, validateArtifact(a).errors.join(';'));
        a.dimensions.find(d => d.id === 'actions.edit').value = { enabled: true }; assert.equal(validateArtifact(a).valid, false);
        const b = pinned(); delete b.dimensions.find(d => d.id === 'booking.slots').value.step_minutes; assert.equal(validateArtifact(b).valid, false);
    });
    it('rejects shared decision conflicts and unresolved dependencies', () => {
        const a = pinned(); a.dimensions.find(d => d.id === 'booking.services').value.items[0].name = 'Different'; assert.equal(validateArtifact(a).valid, false);
        const b = pinned(); b.dimensions.find(d => d.id === 'booking.hours').state = 'unresolved'; delete b.dimensions.find(d => d.id === 'booking.hours').value; assert.equal(validateArtifact(b).valid, false);
    });
    it('validates custom schemas before unresolved or delegated coverage can pass', () => {
        for (const state of ['unresolved','delegated']) {
            const a=candidate(); a.dimensions.push({id:'custom.policy',label:'Policy',reason:'Domain-specific decision',state,sources:state==='delegated'?source:[],...(state==='delegated'?{constraints:[]}:{}),value_schema:{type:'string',format:'email'}});
            const result=validateArtifact(a); assert.equal(result.valid,false); assert.match(result.errors.join(';'),/unsupported schema keyword format/);
        }
    });
    it('malformed schema combinators and regex return errors without throwing', () => {
        for (const schema of [{oneOf:{}},{required:'field'},{type:'unknown'},{properties:[]},{pattern:'['},{items:false}]) {
            assert.doesNotThrow(()=>validateValue('value',schema)); assert.ok(validateValue('value',schema).length);
            const a=candidate(); a.dimensions.push({id:'custom.policy',label:'Policy',reason:'Custom policy',state:'unresolved',sources:[],value_schema:schema}); assert.equal(validateArtifact(a).valid,false);
        }
    });
    it('rejects model delegation and undocumented exclusions', () => {
        const a = candidate(); a.dimensions[0] = { id: a.dimensions[0].id, state: 'delegated', constraints: [], sources: [{ kind: 'model', ref: 'assumption' }] }; assert.equal(validateArtifact(a).valid, false);
        a.dimensions[0] = { id: a.dimensions[0].id, state: 'not_applicable', sources: source }; assert.equal(validateArtifact(a).valid, false);
    });
});
describe('coverage gate transitions', () => {
    it('moves DRAFT -> AWAITING_APPROVAL -> PASSED', () => {
        const a = pinned(), p = plan(a); assert.equal(evaluateGate({ plan: p, artifact: a, reconnaissance_complete: false }).state, 'DRAFT');
        assert.equal(evaluateGate({ plan: p, artifact: a }).state, 'AWAITING_APPROVAL');
        assert.equal(evaluateGate({ plan: p, artifact: a, receipt: receipt(a,p) }).state, 'PASSED');
    });
    it('invalidates plan, digest, catalog, baseline and task identity changes', () => {
        const a = pinned(), p = plan(a), r = receipt(a,p);
        for (const options of [{ plan: {...p,plan_revision:2}}, { artifact: {...a,revision:2}}, { plan: {...p,coverage:{...p.coverage,catalog_version:2}}}, { baseline:'different'}, { plan: {...p,tasks:[{task_id:'OTHER'}]}}]) assert.equal(evaluateGate({ plan:p, artifact:a, receipt:r, ...options }).state,'STALE');
    });
    it('malformed v2 remains INVALID; v1 explicitly warns', () => {
        assert.equal(evaluateGate({ plan:{schema_version:2} }).state, 'INVALID');
        const legacy = evaluateGate({plan:{schema_version:1}}); assert.equal(legacy.allowed,true); assert.match(legacy.warning,/LEGACY_UNCHECKED/);
    });
});
describe('coverage approval compare-and-set', () => {
    let root, a, p, store;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(),'coverage-')); fs.mkdirSync(path.join(root,'.omni/sdlc'),{recursive:true}); a=candidate(); p=plan(a); fs.writeFileSync(path.join(root,p.coverage.path),JSON.stringify(a)); fs.writeFileSync(path.join(root,'.omni/sdlc/dual-plan.json'),JSON.stringify(p)); store=new CoverageStore(root); });
    afterEach(() => fs.rmSync(root,{recursive:true,force:true}));
    function decisions() { return pinned().dimensions.map(({sources,...d})=>d); }
    it('headless without receipt blocks; exact preapproval passes without mutating candidate', () => {
        const before=fs.readFileSync(path.join(root,p.coverage.path),'utf8'); assert.equal(store.inspect().code,'SPEC_COVERAGE_REQUIRED');
        store.approve(request(a,decisions()),{baseline:{kind:'git',id:'base'}}); const result=store.inspect({baseline:{kind:'git',id:'base'}}); assert.equal(result.state,'PASSED'); assert.equal(result.effective_artifact.dimensions[0].state,'pinned'); assert.equal(fs.readFileSync(path.join(root,p.coverage.path),'utf8'),before);
    });
    it('rejects stale digest and same request with different content; replays identical content', () => {
        const req=request(a,decisions()); assert.throws(()=>store.approve({...req,candidate_digest:'old'}),{code:'STALE_COVERAGE'});
        const result=store.approve(req); assert.deepEqual(store.approve(req),result); assert.throws(()=>store.approve({...req,actor:'different'}),{code:'APPROVAL_REQUEST_CONFLICT'});
        assert.throws(()=>store.approve({...req,request_id:'other'}),{code:'STALE_COVERAGE'});
    });
    it('partial approval remains pending and later submission merges explicit rows', () => {
        const all=decisions(); const first=store.approve(request(a,all.slice(0,2))); assert.equal(first.state,'AWAITING_APPROVAL'); assert.equal(store.inspect().allowed,false);
        const second=store.approve({...request(a,all.slice(2)),request_id:'approve-2'}); assert.equal(second.state,'PASSED'); assert.equal(store.inspect().state,'PASSED');
    });
    it('repository convention changes invalidate previously approved coverage', () => {
        const rulesFile=path.join(root,'rules.md'); fs.writeFileSync(rulesFile,'Current convention');
        a=pinned(); a.dimensions[0].sources=[{kind:'repository',ref:'rules.md#entities',path:'rules.md',section:'entities',digest:digest('Current convention')}];
        p=plan(a); fs.writeFileSync(path.join(root,p.coverage.path),JSON.stringify(a)); fs.writeFileSync(path.join(root,'.omni/sdlc/dual-plan.json'),JSON.stringify(p));
        store.approve(request(a,[])); assert.equal(store.inspect().state,'PASSED');
        fs.writeFileSync(rulesFile,'Changed convention'); assert.equal(store.inspect().state,'STALE');
    });
    it('reconnaissance changes invalidate the receipt binding', () => {
        const recon=digest('scouted all tasks'); store.approve(request(a,pinned().dimensions.map(({sources,...decision})=>decision)),{reconnaissance_digest:recon});
        assert.equal(store.inspect({reconnaissance_digest:recon}).state,'PASSED');
        assert.equal(store.inspect({reconnaissance_digest:digest('new scout finding')}).state,'STALE');
    });
    it('new plan revision can approve again without deleting superseded immutable receipt', () => {
        const first=request(a,decisions()); store.approve(first);
        p.plan_revision=2; fs.writeFileSync(path.join(root,'.omni/sdlc/dual-plan.json'),JSON.stringify(p));
        assert.equal(store.inspect().state,'STALE');
        const next={...request(a,decisions()),request_id:'approve-revision-2',plan_revision:2};
        store.approve(next); assert.equal(store.inspect().state,'PASSED');
        assert.equal(store.inspect().receipt.plan_revision,2);
        store.approve(first); assert.equal(store.inspect().receipt.plan_revision,2);
    });
    it('approval cannot replace candidate metadata or schemas', () => {
        assert.throws(()=>store.approve(request(a,[{id:'actions.create',state:'pinned',value:{enabled:false},value_schema:{}}])),{code:'INVALID_APPROVAL'});
    });
    it('malformed v2 disk plan never falls back to legacy', () => {
        delete p.acceptance_policy; fs.writeFileSync(path.join(root,'.omni/sdlc/dual-plan.json'),JSON.stringify(p)); assert.equal(store.inspect().state,'INVALID');
    });
    it('tampering and retry/resume cannot reuse approved binding', () => {
        store.approve(request(a,decisions())); a.revision++; fs.writeFileSync(path.join(root,p.coverage.path),JSON.stringify(a));
        assert.equal(inspectWorkspaceCoverage(root).state,'STALE'); assert.equal(inspectWorkspaceCoverage(root).allowed,false);
    });
});
describe('delegated decision log', () => {
    function fixture() { const a=pinned(); const row=a.dimensions.find(d=>d.id==='booking.slots'); row.state='delegated'; delete row.value; row.constraints=[{type:'object',properties:{duration_minutes:{const:60}}}]; return a; }
    function entry() { return {dimension_id:'booking.slots',chosen_value:{mode:'generated',duration_minutes:60,step_minutes:30,boundary:'end within operating window'},rationale:'User allowed slot layout',evidence_refs:['src/booking.js:10']}; }
    it('accepts 17 pinned echoes or an empty log with an empty binding', () => {
        const a = { ...pinned(), app_types: ['core'], dimensions: expandCatalog(['core']).map(d => ({ id: d.id, state: 'pinned', value: d.examples[0], sources: source })) };
        const echoes = a.dimensions.map(d => ({ dimension_id: d.id, chosen_value: d.value }));
        assert.equal(echoes.length, 17);
        for (const entries of [echoes, []]) assert.deepEqual(validateDecisionLog(a, entries, { decision_ids: [] }), { valid: true, errors: [], advisories: [] });
        // Skipped rows are neither duplicate-checked nor compared against pinned values.
        assert.equal(validateDecisionLog(a, [...echoes, { ...echoes[0], chosen_value: null }], { decision_ids: [] }).valid, true);
    });
    it('still rejects pinned entries when bound or when binding is undefined', () => {
        const a = pinned(), row = a.dimensions[0];
        for (const options of [{ decision_ids: [row.id] }, { decision_ids: undefined }]) {
            const r = validateDecisionLog(a, [{ dimension_id: row.id, chosen_value: row.value }], options);
            assert.equal(r.valid, false);
            assert.ok(r.errors.includes(`${row.id}: new/unresolved or non-delegated decision`));
        }
    });
    it('still rejects unknown entries and delegated entries outside an empty binding', () => {
        for (const dimension_id of ['new.dimension', 'booking.slots']) {
            const r = validateDecisionLog(fixture(), [{ ...entry(), dimension_id }], { decision_ids: [] });
            assert.equal(r.valid, false);
            assert.ok(r.errors.includes(dimension_id === 'booking.slots' ? `${dimension_id}: decision outside task binding` : `${dimension_id}: new/unresolved or non-delegated decision`));
        }
    });
    it('requires bound delegated entries and checks schema, rationale, evidence and constraints', () => {
        const options = { decision_ids: ['booking.slots'] };
        assert.ok(validateDecisionLog(fixture(), [], options).errors.includes('booking.slots: missing decision log'));
        for (const change of [
            { chosen_value: null }, { rationale: '' }, { evidence_refs: [] },
            { chosen_value: { ...entry().chosen_value, duration_minutes: 45 } }
        ]) {
            const r = validateDecisionLog(fixture(), [{ ...entry(), ...change }], options);
            assert.equal(r.valid, false, JSON.stringify(change));
            assert.ok(r.errors.length);
        }
        const a = fixture(); a.dimensions.find(d => d.id === 'booking.slots').constraints = ['Keep existing slots'];
        assert.match(validateDecisionLog(a, [entry()], options).errors.join(';'), /textual constraint requires an explicit review finding/);
        assert.match(validateDecisionLog(fixture(), [entry(), entry()], options).errors.join(';'), /duplicate decision log/);
    });
    it('accepts choice within constraints as advisory',()=>{const r=validateDecisionLog(fixture(),[entry()],{decision_ids:['booking.slots']}); assert.equal(r.valid,true,r.errors.join(';')); assert.equal(r.advisories.length,1);});
    it('rejects outside constraints, missing log and new/unapproved decisions',()=>{
        const e=entry(); e.chosen_value.duration_minutes=45; assert.equal(validateDecisionLog(fixture(),[e]).valid,false);
        assert.equal(validateDecisionLog(fixture(),[],{decision_ids:['booking.slots']}).valid,false);
        assert.equal(validateDecisionLog(fixture(),[{...entry(),dimension_id:'new.dimension'}]).valid,false);
        assert.equal(validateDecisionLog(candidate(),[entry()]).valid,false);
    });
});
