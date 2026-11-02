'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const api = () => {
    assert.ok(fs.existsSync(path.join(__dirname, 'helpers/acceptance-evidence.js')), 'P7c evidence helper must exist');
    return require('./helpers/acceptance-evidence');
};
function temp(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-evidence-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('reports recursively redact secrets, email, home paths and UI token fragments without changing raw data', () => {
    const { redactReport } = api();
    const raw = { token: 'private-value', api_key: 'private-key', usage: { input_tokens: 123, output_tokens: 5 },
        nested: ['reader@example.com /Users/reader/work C:\\Users\\Reader\\work /home/reader/project /root/work',
            '{"path":"C:\\\\Users\\\\Reader\\\\work","password":"private-password"}',
            'Authorization: Bearer private-bearer', 'http://127.0.0.1:1234/#token=private-ui-token'],
        other: 'opaque-known-value' };
    const before = JSON.stringify(raw);
    const safe = redactReport(raw, { secrets: ['opaque-known-value'] });
    const text = JSON.stringify(safe);
    for (const forbidden of ['private-value', 'private-key', 'private-password', 'private-bearer', 'private-ui-token', 'opaque-known-value',
        'reader@example.com', '/Users/reader', '/home/reader', '/root/work', 'Reader']) assert.ok(!text.includes(forbidden), forbidden);
    assert.deepEqual(safe.usage, raw.usage);
    assert.equal(JSON.stringify(raw), before);
});

test('UTF-8 tails stay within 2048 bytes and preserve trailing multibyte text', () => {
    const { utf8Tail } = api();
    const text = 'prefix'.repeat(500) + 'Tiếng Việt 🧪'.repeat(250);
    const tail = utf8Tail(Buffer.from(text), 2048);
    assert.ok(Buffer.byteLength(tail) <= 2048);
    assert.ok(text.endsWith(tail));
    assert.ok(!tail.includes('\ufffd'));
});

function capture(t, overrides = {}) {
    const root = temp(t);
    fs.mkdirSync(path.join(root, 'turns'));
    const records = [
        { turnId: 'good', runtime: 'codex', model: 'm', role: 'reviewer', kind: 'turn', processStarted: true,
            exitCode: 0, finalized: true, contract: { status: 'valid' }, usage: { inputTokens: 20, outputTokens: 2 } },
        { turnId: 'failed', runtime: 'agy', model: 'm', role: 'worker', kind: 'seed', processStarted: true,
            exitCode: 7, finalized: true, contract: { status: 'failed' }, sameRuntimeCountAtEnd: 2,
            stderrTailBase64: Buffer.from('bad reader@example.com /Users/reader/cache token=private-token').toString('base64'),
            jsonErrors: [{ error: { message: 'private-known' } }], retry: { policy: 'technical', applied: true } },
        { turnId: 'invalid', runtime: 'claude', model: 'm', role: 'discussion', kind: 'turn', processStarted: true,
            exitCode: 0, finalized: true, contract: { status: 'failed', code: 'INVALID_CONTRACT' }, stderrTail: '',
            retry: { policy: 'nudge', applied: true } },
    ];
    for (const record of records) fs.writeFileSync(path.join(root, 'turns', `${record.turnId}.json`), JSON.stringify(record));
    fs.writeFileSync(path.join(root, 'capture-status.json'), JSON.stringify({ schema_version: 1, protocol: 'omni-acceptance-telemetry-v1',
        complete: true, turnCount: 3, endedCount: 3, finalizedCount: 3, pendingTurnIds: [], errors: [], ...overrides }));
    return root;
}

test('capture collector includes recovered failures and exit-zero contract failures, not valid verdicts', (t) => {
    const { collectRuntimeEvidence } = api();
    const result = collectRuntimeEvidence(capture(t), { secrets: ['private-known'] });
    assert.equal(result.complete, true);
    assert.equal(result.turns.length, 3);
    assert.deepEqual(result.runtimeFailures.map((failure) => failure.turnId).sort(), ['failed', 'invalid']);
    const failed = result.runtimeFailures.find((failure) => failure.turnId === 'failed');
    assert.equal(failed.sameRuntimeCountAtEnd, 2);
    assert.deepEqual(failed.retry, { policy: 'technical', applied: true });
    assert.ok(Buffer.byteLength(failed.stderrTail) <= 2048);
    assert.doesNotMatch(JSON.stringify(result.runtimeFailures), /private-|reader@example\.com|\/Users\/reader/);
});

test('capture collector marks missing, pending and mismatched evidence incomplete', (t) => {
    const { collectRuntimeEvidence } = api();
    assert.equal(collectRuntimeEvidence(temp(t)).complete, false);
    assert.equal(collectRuntimeEvidence(capture(t, { pendingTurnIds: ['lost'], finalizedCount: 2 })).complete, false);
    assert.equal(collectRuntimeEvidence(capture(t, { turnCount: 4 })).complete, false);
    assert.equal(collectRuntimeEvidence(capture(t, { complete: false, errors: [{ code: 'EIO' }] })).complete, false);
});

test('raw evidence archive keeps original bytes privately and never follows symlinks', (t) => {
    const { copyPrivateEvidence } = api();
    const root = temp(t), source = path.join(root, 'source'), target = path.join(root, 'archive');
    fs.mkdirSync(source);
    const bytes = Buffer.from('{"hash":"abc","email":"reader@example.com"}\n');
    fs.writeFileSync(path.join(source, 'events.ndjson'), bytes);
    const result = copyPrivateEvidence(source, target);
    assert.equal(result.files, 1);
    assert.deepEqual(fs.readFileSync(path.join(target, 'events.ndjson')), bytes);
    assert.equal(result.sha256['events.ndjson'], crypto.createHash('sha256').update(bytes).digest('hex'));
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(target).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(target, 'events.ndjson')).mode & 0o777, 0o600);
    }
    fs.writeFileSync(path.join(root, 'outside-secret'), 'never copy this');
    fs.symlinkSync(path.join(root, 'outside-secret'), path.join(source, 'escape'));
    assert.throws(() => copyPrivateEvidence(source, path.join(root, 'unsafe-copy')), { code: 'ACCEPTANCE_EVIDENCE_SYMLINK' });
    assert.ok(!fs.existsSync(path.join(root, 'unsafe-copy', 'escape')));
});

test('JSON and Markdown report writers only persist the recursively sanitized view', (t) => {
    const { writeAcceptanceReport } = api();
    const outDir = temp(t);
    const report = { protocol: 'test', config: 'A', ok: false, completeSuite: false, workspaceRoot: '/Users/private/work',
        error: 'reader@example.com token=private-token', measurements: { thresholds: {
            requirements: { passed: false, met: 0, total: 1, violations: [{ task_id: 'T01', sequence: 3, code: 'FAILED' }] },
        } }, runtimeFailures: [] };
    writeAcceptanceReport(outDir, report);
    for (const name of ['report.json', 'report.md']) {
        const text = fs.readFileSync(path.join(outDir, name), 'utf8');
        assert.doesNotMatch(text, /\/Users\/private|reader@example\.com|private-token/);
        assert.match(text, /requirements/);
        if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(outDir, name)).mode & 0o777, 0o600);
    }
});

test('stderr redaction happens before tail clipping and removes orphaned truncated tokens', (t) => {
    const { collectRuntimeEvidence } = api();
    const root = capture(t);
    const file = path.join(root, 'turns', 'failed.json');
    const turn = JSON.parse(fs.readFileSync(file, 'utf8'));
    const secret = 'confidential'.repeat(400);
    const full = Buffer.from(`token=${secret}\nfailed safely`);
    Object.assign(turn, { stderrBase64: full.toString('base64'), stderrBytes: full.length, stderrTruncated: false,
        stderrTailBase64: full.subarray(-2048).toString('base64') });
    fs.writeFileSync(file, JSON.stringify(turn));
    assert.doesNotMatch(collectRuntimeEvidence(root).runtimeFailures[0].stderrTail, /confidential/);
    Object.assign(turn, { stderrBase64: '', stderrTruncated: true });
    fs.writeFileSync(file, JSON.stringify(turn));
    const tail = collectRuntimeEvidence(root).runtimeFailures[0].stderrTail;
    assert.doesNotMatch(tail, /confidential/);
    assert.match(tail, /failed safely/);
});

test('capture IO failure marker and duplicate identities fail integrity even with an apparently clean status', (t) => {
    const { collectRuntimeEvidence } = api();
    const root = capture(t), daemonLog = path.join(root, 'daemon.log');
    fs.writeFileSync(daemonLog, 'OMNI_SQUAD_ACCEPTANCE_CAPTURE_INCOMPLETE\n');
    assert.equal(collectRuntimeEvidence(root, {}, { daemonLog }).complete, false);
    const file = path.join(root, 'turns', 'invalid.json');
    const turn = JSON.parse(fs.readFileSync(file, 'utf8')); turn.turnId = 'failed';
    fs.writeFileSync(file, JSON.stringify(turn));
    assert.equal(collectRuntimeEvidence(root).complete, false);
});

test('structured provider error fields redact prefixed secret names while retaining numeric usage', () => {
    const { redactReport } = api();
    const safe = redactReport({ error: { PROVIDER_API_KEY: 'opaque-api-value', CUSTOM_TOKEN: 'opaque-token-value',
        refreshToken: 'opaque-refresh-value', db_password: 'opaque-password-value' }, usage: { input_tokens: 5, outputTokens: 3 } });
    assert.doesNotMatch(JSON.stringify(safe), /opaque-/);
    assert.deepEqual(safe.usage, { input_tokens: 5, outputTokens: 3 });
});
