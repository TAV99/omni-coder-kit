'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    resolveTaskAgyPrefixArgs,
    resolveRegisteredAgyProjectId,
} = require('../lib/dual/agy-project');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');

test('resolveTaskAgyPrefixArgs - isolated retains explicit prefix args unchanged without source binding', () => {
    const inputArgs = ['--flag', 'value'];
    const result = resolveTaskAgyPrefixArgs({
        executionMode: 'isolated',
        agyPrefixArgs: inputArgs,
        agyProjectId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    });

    assert.deepStrictEqual(result, ['--flag', 'value']);
});

test('resolveTaskAgyPrefixArgs - preserve explicitly unsafe args so runner rejects', () => {
    const unsafeArgs = ['--unsafe-flag', 'malicious-payload', '--custom-exec=/bin/sh'];

    const isolatedResult = resolveTaskAgyPrefixArgs({
        executionMode: 'isolated',
        agyPrefixArgs: unsafeArgs,
        agyProjectId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    });
    assert.deepStrictEqual(isolatedResult, unsafeArgs);

    const sharedResult = resolveTaskAgyPrefixArgs({
        executionMode: 'shared',
        agyPrefixArgs: unsafeArgs,
        agyProjectId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    });
    assert.deepStrictEqual(sharedResult, [
        '--unsafe-flag',
        'malicious-payload',
        '--custom-exec=/bin/sh',
        '--project',
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    ]);
});

test('resolveTaskAgyPrefixArgs - shared mode appends project flag when valid UUID and no preexisting selector', () => {
    const validId = '12345678-1234-1234-1234-123456789abc';
    const result = resolveTaskAgyPrefixArgs({
        executionMode: 'shared',
        agyPrefixArgs: ['--verbose'],
        agyProjectId: validId,
    });

    assert.deepStrictEqual(result, ['--verbose', '--project', validId]);
});

test('resolveTaskAgyPrefixArgs - shared mode does not append if preexisting project selector exists', () => {
    const validId = '12345678-1234-1234-1234-123456789abc';
    const existingId = '87654321-4321-4321-4321-cba987654321';

    const withFlag = resolveTaskAgyPrefixArgs({
        executionMode: 'shared',
        agyPrefixArgs: ['--project', existingId],
        agyProjectId: validId,
    });
    assert.deepStrictEqual(withFlag, ['--project', existingId]);

    const withEquals = resolveTaskAgyPrefixArgs({
        executionMode: 'shared',
        agyPrefixArgs: [`--project=${existingId}`],
        agyProjectId: validId,
    });
    assert.deepStrictEqual(withEquals, [`--project=${existingId}`]);
});

test('resolveTaskAgyPrefixArgs - validates UUID and ignores invalid project id', () => {
    const invalidIds = ['invalid-uuid', '12345', '../../escape', '', null, undefined, {}];
    for (const invalidId of invalidIds) {
        const result = resolveTaskAgyPrefixArgs({
            executionMode: 'shared',
            agyPrefixArgs: ['--foo'],
            agyProjectId: invalidId,
        });
        assert.deepStrictEqual(result, ['--foo']);
    }
});

test('resolveTaskAgyPrefixArgs - does not mutate input args', () => {
    const inputArgs = Object.freeze(['--frozen', 'arg']);
    const validId = '12345678-1234-1234-1234-123456789abc';

    const isolatedResult = resolveTaskAgyPrefixArgs({
        executionMode: 'isolated',
        agyPrefixArgs: inputArgs,
        agyProjectId: validId,
    });
    assert.notStrictEqual(isolatedResult, inputArgs);
    assert.deepStrictEqual(isolatedResult, ['--frozen', 'arg']);

    const sharedResult = resolveTaskAgyPrefixArgs({
        executionMode: 'shared',
        agyPrefixArgs: inputArgs,
        agyProjectId: validId,
    });
    assert.notStrictEqual(sharedResult, inputArgs);
    assert.deepStrictEqual(sharedResult, ['--frozen', 'arg', '--project', validId]);
    assert.deepStrictEqual(inputArgs, ['--frozen', 'arg']);
});

test('daemon wiring regression - passes agyProjectId as option instead of raw prefix args', () => {
    const daemonSrc = fs.readFileSync(path.join(__dirname, '../bin/omni-daemon.js'), 'utf8');
    assert.ok(
        !daemonSrc.includes("agyPrefixArgs: ['--project'"),
        'omni-daemon.js should not construct raw --project in agyPrefixArgs'
    );
    assert.ok(
        daemonSrc.includes('agyProjectId'),
        'omni-daemon.js should pass agyProjectId option to createOrchestratorAdapter'
    );
});
