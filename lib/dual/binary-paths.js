'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function codexPathCandidates({ homedir = os.homedir(), env = process.env } = {}) {
    return [
        ...(typeof env.OMNI_CODEX_PATH === 'string' && env.OMNI_CODEX_PATH.trim()
            ? [env.OMNI_CODEX_PATH] : []),
        path.join(homedir, '.local', 'bin', 'codex'),
        path.join(homedir, 'bin', 'codex'),
        '/usr/bin/codex',
    ];
}

function resolveCodexPath({ fsImpl = fs, homedir = os.homedir(), env = process.env } = {}) {
    return codexPathCandidates({ homedir, env }).find((candidate) => fsImpl.existsSync(candidate)) ?? null;
}

function agyPathCandidates({ homedir = os.homedir(), env = process.env } = {}) {
    return [
        ...(typeof env.OMNI_AGY_PATH === 'string' && env.OMNI_AGY_PATH.trim()
            ? [env.OMNI_AGY_PATH] : []),
        path.join(homedir, '.local', 'bin', 'agy'),
        path.join(homedir, 'bin', 'agy'),
        'agy',
    ];
}

function resolveAgyPath({ fsImpl = fs, homedir = os.homedir(), env = process.env } = {}) {
    return agyPathCandidates({ homedir, env })
        .find((candidate) => path.isAbsolute(candidate) && fsImpl.existsSync(candidate)) ?? 'agy';
}

function restoreCommands({ worktree, homedir = os.homedir() }) {
    return [
        ['npm', 'i', '-g', '--prefix', path.join(homedir, '.local'), '@openai/codex@0.164.0'],
        ['ln', '-sf', path.join(worktree, 'bin', 'omni.js'), path.join(homedir, '.local', 'bin', 'omni')],
    ];
}

module.exports = { codexPathCandidates, resolveCodexPath, agyPathCandidates, resolveAgyPath, restoreCommands };
