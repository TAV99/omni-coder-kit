#!/usr/bin/env node
'use strict';

const {
    evaluateHook,
    extractEventHint,
    serializeBoundedOutput,
} = require('../lib/dual/hook-bridge');

const MAX_INPUT_BYTES = 64 * 1024; // 64 KiB
const MAX_PREFIX_SCAN = 4096;

let rawData = '';
let prefixScan = '';
let bytesRead = 0;
let exceeded = false;

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    if (exceeded) return;
    bytesRead += Buffer.byteLength(chunk, 'utf8');
    if (prefixScan.length < MAX_PREFIX_SCAN) {
        const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        prefixScan += chunkStr.slice(0, MAX_PREFIX_SCAN - prefixScan.length);
    }
    if (bytesRead > MAX_INPUT_BYTES) {
        exceeded = true;
        process.stdin.pause();
        process.stderr.write('[omni-hook] Error: stdin exceeded 64 KiB limit\n');
        const eventHint = extractEventHint(prefixScan);
        let fallback;
        if (eventHint === 'PreToolUse') {
            fallback = {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: '[omni-blocked] hook input exceeded 64 KiB limit',
                },
            };
        } else {
            fallback = {
                systemMessage: '[omni-blocked] hook input exceeded 64 KiB limit',
            };
        }
        const outputJson = serializeBoundedOutput(fallback);
        process.stdout.write(outputJson + '\n', () => {
            process.exitCode = 0;
        });
        return;
    }
    rawData += chunk;
});

process.stdin.on('end', async () => {
    if (exceeded) return;

    let input;
    try {
        input = JSON.parse(rawData);
    } catch {
        process.stderr.write('[omni-hook] Error: invalid JSON\n');
        const eventHint = extractEventHint(prefixScan || rawData.slice(0, MAX_PREFIX_SCAN));
        let fallback;
        if (eventHint === 'PreToolUse') {
            fallback = {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: '[omni-blocked] invalid JSON input',
                },
            };
        } else {
            fallback = {
                systemMessage: '[omni-blocked] invalid JSON input',
            };
        }
        const outputJson = serializeBoundedOutput(fallback);
        process.stdout.write(outputJson + '\n', () => {
            process.exitCode = 0;
        });
        return;
    }

    try {
        const result = await evaluateHook(input);
        const outputJson = serializeBoundedOutput(result);
        process.stdout.write(outputJson + '\n', () => {
            process.exitCode = 0;
        });
    } catch {
        process.stderr.write('[omni-hook] Error: internal hook error\n');
        let fallback;
        if (input && typeof input === 'object' && input.hook_event_name === 'PreToolUse') {
            fallback = {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: '[omni-blocked] internal hook error',
                },
            };
        } else {
            fallback = {
                systemMessage: '[omni-blocked] internal hook error',
            };
        }
        const outputJson = serializeBoundedOutput(fallback);
        process.stdout.write(outputJson + '\n', () => {
            process.exitCode = 0;
        });
    }
});

process.on('SIGINT', () => {
    process.exitCode = 0;
});

process.on('SIGTERM', () => {
    process.exitCode = 0;
});
