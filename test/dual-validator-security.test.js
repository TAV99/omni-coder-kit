'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    deriveQualityExecutionId,
    executeQualityPlan,
    persistQualityExecutionArtifact,
    qualityGateResults,
    runBoundedCommand,
    verifyQualityExecutionArtifact,
} = require('../lib/dual/quality-runner');
const { runSetupActions } = require('../lib/dual/setup-runner');
const {
    buildValidatorEnv,
    redactArgv,
    redactDiagnostic,
} = require('../lib/dual/validator-security');

test('buildValidatorEnv excludes credentials and preserves required runtime variables', () => {
    const env = buildValidatorEnv({
        PATH: '/bin',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        AWS_SECRET_ACCESS_KEY: 'secret',
        GITHUB_TOKEN: 'ghp_secret',
        CUSTOM_SECRET: 'hidden',
    });

    assert.equal(env.PATH, '/bin');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.TEMP, 'C:\\Temp');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.CUSTOM_SECRET, undefined);
});

test('buildValidatorEnv admits explicit safe overrides but rejects credential-shaped overrides', () => {
    const env = buildValidatorEnv(
        { PATH: '/bin', GITHUB_TOKEN: 'source-token' },
        { GIT_CEILING_DIRECTORIES: '/workspace', CUSTOM_SECRET: 'override-secret' }
    );

    assert.deepEqual(env, { PATH: '/bin', GIT_CEILING_DIRECTORIES: '/workspace' });
});

test('redactDiagnostic removes bearer URL JSON environment and argv secrets', () => {
    const output = redactDiagnostic(
        'Bearer abc123 https://x.test?a=secret&safe=value '
        + '{"token":"json-secret"} CUSTOM_SECRET=hidden --api-key cli-secret '
        + 'Authorization: Basic basic-secret'
    );

    assert.doesNotMatch(output, /abc123|a=secret|safe=value|json-secret|CUSTOM_SECRET=hidden|api-key cli-secret|basic-secret/);
    assert.match(output, /\[REDACTED\]/);
});

test('redactDiagnostic consumes quoted bearer secrets across embedded delimiters', () => {
    assert.equal(
        redactDiagnostic('Authorization: Bearer "opaque,tail"'),
        'Authorization: [REDACTED]'
    );
    assert.equal(redactDiagnostic('Bearer "opaque;tail"'), 'Bearer [REDACTED]');
    assert.equal(
        redactDiagnostic('Authorization: Bearer "opaque\\",tail;still-secret"'),
        'Authorization: [REDACTED]'
    );
    assert.equal(
        redactDiagnostic('Authorization: Bearer unquoted multiword secret; next=visible'),
        'Authorization: [REDACTED]; next=visible'
    );
    assert.equal(redactDiagnostic('Bearer unquoted multiword secret, next'), 'Bearer [REDACTED], next');
});

test('redactDiagnostic redacts JSON-escaped secret keys without hiding nested safe fields', () => {
    const diagnostic = '{"outer":{"client\\u005fsecret":"ENCODED_CLIENT_SECRET,with;delimiters and \\"quoted\\" tail",'
        + '"safe":"visible nested"},'
        + '"token\\u005fsecret":"ENCODED_TOKEN_SECRET","status":"healthy"}';
    assert.equal(
        JSON.parse(diagnostic).outer.client_secret,
        'ENCODED_CLIENT_SECRET,with;delimiters and "quoted" tail'
    );
    const output = redactDiagnostic(diagnostic);

    assert.doesNotMatch(output, /ENCODED_CLIENT_SECRET|ENCODED_TOKEN_SECRET/);
    assert.match(output, /"safe":"visible nested"/);
    assert.match(output, /"status":"healthy"/);
});

test('redactDiagnostic handles structured values and applies a deterministic output bound', () => {
    const output = redactDiagnostic({
        message: 'failed',
        authorization: 'Bearer structured-secret',
        nested: { password: 'json-password', detail: 'x'.repeat(200) },
    }, { maxLength: 96 });

    assert.equal(typeof output, 'string');
    assert.ok(output.length <= 96);
    assert.doesNotMatch(output, /structured-secret|json-password/);
});

test('redactDiagnostic removes prefixed credential keys in structured and serialized JSON', () => {
    for (const value of [
        { client_secret: 'JSONLEAK', AWS_SECRET_ACCESS_KEY: 'AWSLEAK', refresh_token: 'REFRESHLEAK' },
        '{"client_secret":"JSONLEAK","AWS_SECRET_ACCESS_KEY":"AWSLEAK","refresh_token":"REFRESHLEAK"}',
    ]) {
        const output = redactDiagnostic(value);
        assert.doesNotMatch(output, /JSONLEAK|AWSLEAK|REFRESHLEAK/);
    }
});

test('redactArgv preserves command shape while removing split and inline secret values', () => {
    assert.deepEqual(
        redactArgv(['test', '--api-key', 'secret-1', '--token=secret-2', 'https://x.test?q=secret-3']),
        ['test', '--api-key', '[REDACTED]', '--token=[REDACTED]', 'https://x.test?q=[REDACTED]']
    );
});

test('redactArgv masks prefixed credential aliases as split and inline options', () => {
    assert.deepEqual(
        redactArgv([
            '--client-secret', 'client secret with spaces',
            '--refresh-token=refresh alias secret',
            '--aws-secret-access-key', 'aws alias secret',
        ]),
        [
            '--client-secret', '[REDACTED]',
            '--refresh-token=[REDACTED]',
            '--aws-secret-access-key', '[REDACTED]',
        ]
    );
});

test('quality validators receive an allowlisted environment and return only redacted diagnostics', () => {
    let receivedOptions;
    const result = runBoundedCommand({ program: 'node', args: ['--check', 'index.js'] }, {
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        env: { PATH: process.env.PATH || '', TEMP: process.env.TEMP || '', GITHUB_TOKEN: 'ghp_quality_secret' },
        spawnSyncImpl(command, args, options) {
            receivedOptions = options;
            return {
                status: 1,
                signal: null,
                stdout: 'Bearer quality-secret',
                stderr: 'https://x.test?token=query-secret',
                error: Object.assign(new Error('CUSTOM_SECRET=error-secret'), { code: 'EFAIL' }),
            };
        },
    });

    assert.equal(receivedOptions.env.GITHUB_TOKEN, undefined);
    assert.equal(receivedOptions.env.PATH, process.env.PATH || '');
    assert.doesNotMatch(JSON.stringify(result), /ghp_quality_secret|quality-secret|query-secret|error-secret/);
    assert.match(result.output, /\[REDACTED\]/);
});

test('unavailable quality commands do not return raw secret-bearing argv', () => {
    const [result] = executeQualityPlan({ commands: [{
        id: 'registered-test',
        name: 'registered test --token unavailable-name-secret',
        program: 'tool',
        args: ['--token', 'unavailable-secret'],
        cwd: '.',
        available: false,
    }] }, { workspaceRoot: process.cwd() });

    assert.doesNotMatch(JSON.stringify(result), /unavailable-secret|unavailable-name-secret/);
    assert.deepEqual(result.args, ['--token', '[REDACTED]']);
});

test('quality artifact verification binds raw argv even when persisted argv is redacted', (t) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-validator-identity-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"validator-identity"}\n');
    const authorityDir = path.join(workspaceRoot, '.omni', 'runs', 'dual-authority');
    fs.mkdirSync(authorityDir, { recursive: true });

    const commandPlan = [{
        id: 'registered-test', name: 'registered test', program: 'tool',
        args: ['--token', 'SECRET_A'], cwd: '.', available: true,
    }];
    const identity = {
        workspaceRoot,
        sessionId: crypto.randomUUID(),
        workspaceId: '1'.repeat(64),
        baseline: { kind: 'snapshot', id: '2'.repeat(64) },
        planRevision: 1,
        policySha256: '3'.repeat(64),
        diffFingerprint: '4'.repeat(64),
        cycleIndex: 1,
        attempt: 1,
        totalTasks: 1,
        completedTaskIds: ['TASK-1'],
    };
    const executionId = deriveQualityExecutionId({ ...identity, commandPlan });
    const results = commandPlan.map((command) => ({
        ...command,
        command: 'tool --token [REDACTED]',
        exit_code: 0,
        duration_ms: 1,
        ok: true,
        failure: null,
        signal: null,
        started_at: '2026-09-17T00:00:00.000Z',
        ended_at: '2026-09-17T00:00:00.001Z',
        stdout: '',
        stderr: '',
    }));
    const persisted = persistQualityExecutionArtifact({
        ...identity,
        authorityDir,
        executionId,
        gateResults: qualityGateResults(results),
        startedAt: '2026-09-17T00:00:00.000Z',
        endedAt: '2026-09-17T00:00:00.001Z',
        results,
    });
    const qualityEvidence = {
        cycle_index: 1,
        attempt: 1,
        total_tasks: 1,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: identity.diffFingerprint,
        gate_results: persisted.artifact.gate_results,
        commands: persisted.artifact.commands.map(({ command, exit_code, duration_ms }) => ({ command, exit_code, duration_ms })),
        evidence_sha256: persisted.sha256,
        provenance: { execution_id: executionId, input_fingerprint: identity.diffFingerprint, mode: 'fresh' },
    };

    assert.throws(() => verifyQualityExecutionArtifact({
        authorityDir,
        qualityEvidence,
        expected: {
            ...identity,
            commandPlan: [{ ...commandPlan[0], args: ['--token', 'SECRET_B'] }],
        },
    }), (error) => error?.code === 'DUAL_QUALITY_ARTIFACT_BINDING');
});

test('setup runner diagnostics redact argv output and process errors before returning them', () => {
    const response = runSetupActions([
        { program: 'tool', args: ['--token', 'setup-argv-secret'], cwd: '.', kind: 'native' },
    ], {
        workspaceRoot: process.cwd(),
        platform: process.platform,
        env: { PATH: process.env.PATH || '' },
        resolveExecutable: () => ({ kind: 'native', path: process.execPath }),
        spawnSync: () => ({
            status: 0,
            signal: null,
            stdout: 'Bearer setup-output-secret',
            stderr: 'https://x.test?credential=setup-query-secret',
            error: null,
        }),
    });

    assert.doesNotMatch(JSON.stringify(response), /setup-argv-secret|setup-output-secret|setup-query-secret/);
});

test('setup runner redacts failed actions when resolution fails before spawn', () => {
    assert.throws(() => runSetupActions([
        { program: 'tool', args: ['--token', 'setup-resolution-secret'], cwd: '.', kind: 'native' },
    ], {
        workspaceRoot: process.cwd(),
        platform: process.platform,
        resolveExecutable: () => { throw new Error('CUSTOM_SECRET=resolver-error-secret'); },
    }), (error) => {
        assert.doesNotMatch(JSON.stringify({
            message: error.message,
            details: error.details,
            failedAction: error.failedAction,
        }), /setup-resolution-secret|resolver-error-secret/);
        return true;
    });
});
