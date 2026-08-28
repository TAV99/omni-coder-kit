'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeAuthorityTaskStatus } = require('../lib/commands/dual');
const { buildSkillInstallArgs, generateRetryScript } = require('../lib/commands/equip');

test('authority status exposes active AGY work and released handoff instead of stale ROUTED state', () => {
    const base = {
        state: 'EXECUTING',
        current_baseline: { kind: 'snapshot', id: 'a'.repeat(64) },
        tasks: {
            'TASK-1': { task_id: 'TASK-1', state: 'ROUTED', owner: 'agy' },
        },
    };

    const active = normalizeAuthorityTaskStatus({
        ...base,
        leases: {
            'LEASE-1': { task_id: 'TASK-1', owner: 'agy', status: 'active' },
        },
    }, 'TASK-1');
    assert.equal(active.state, 'AGY_IN_PROGRESS');
    assert.equal(active.nextAction, 'wait_for_agy');

    const released = normalizeAuthorityTaskStatus({
        ...base,
        leases: {
            'LEASE-1': {
                task_id: 'TASK-1',
                owner: 'agy',
                status: 'released',
                release_reason: 'agy_reviewed_awaiting_codex_qc',
            },
        },
    }, 'TASK-1');
    assert.equal(released.state, 'AWAITING_CODEX_QC');
    assert.equal(released.nextAction, 'codex_qc');

    const codexQcLease = normalizeAuthorityTaskStatus({
        ...base,
        leases: {
            'LEASE-1': {
                task_id: 'TASK-1',
                owner: 'agy',
                status: 'released',
                release_reason: 'agy_reviewed_awaiting_codex_qc',
            },
            'LEASE-2': { task_id: 'TASK-1', owner: 'codex', status: 'active' },
        },
    }, 'TASK-1');
    assert.equal(codexQcLease.state, 'AWAITING_CODEX_QC');
    assert.equal(codexQcLease.nextAction, 'codex_qc');
});

test('universal skill installation selects one requested skill per source invocation', () => {
    const skill = { source: 'obra/superpowers', name: 'systematic-debugging' };
    const args = buildSkillInstallArgs(skill, '--agent claude-code codex');

    assert.deepEqual(args, [
        '-y', 'skills', 'add', 'obra/superpowers',
        '--agent', 'claude-code', 'codex',
        '--skill', 'systematic-debugging', '-y',
    ]);
    assert.equal(args.includes('*'), false);

    const windowsRetry = generateRetryScript([skill], '--agent claude-code codex', true);
    const posixRetry = generateRetryScript([skill], '--agent claude-code codex', false);
    assert.match(windowsRetry, /--skill "systematic-debugging" -y/);
    assert.match(posixRetry, /--skill 'systematic-debugging' -y/);
    assert.doesNotMatch(windowsRetry + posixRetry, /--skill ["']\*["']/);
});
