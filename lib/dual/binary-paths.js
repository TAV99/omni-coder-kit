'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Same per-user install dirs as the squad runtime adapters (SPEC-SQUAD-P1 §10).
const { userBinCandidates } = require('../squad/runtimes/install-paths');
const { resolveBinary } = require('../squad/runtimes/resolve-binary');
const claudeRuntime = require('../squad/runtimes/claude');

function codexPathCandidates({ homedir = os.homedir(), env = process.env } = {}) {
    return [
        ...(typeof env.OMNI_CODEX_PATH === 'string' && env.OMNI_CODEX_PATH.trim()
            ? [env.OMNI_CODEX_PATH] : []),
        ...userBinCandidates('codex', homedir, path),
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
        ...userBinCandidates('agy', homedir, path),
        'agy',
    ];
}

function resolveAgyPath({ fsImpl = fs, homedir = os.homedir(), env = process.env } = {}) {
    return agyPathCandidates({ homedir, env })
        .find((candidate) => path.isAbsolute(candidate) && fsImpl.existsSync(candidate)) ?? 'agy';
}

// Claude Code installs vary (native installer, npm, nvm), so the squad resolver
// searches its candidates and PATH; a Windows npm shim becomes node + script.
function resolveClaudeCommand({ env = process.env, homedir = os.homedir(), fsImpl = fs } = {}) {
    const found = resolveBinary(claudeRuntime.binary, { env, homedir, fsImpl });
    return found.found ? { command: found.command, prefixArgs: [...found.prefixArgs] } : { command: 'claude', prefixArgs: [] };
}

function restoreCommands({ worktree, homedir = os.homedir() }) {
    return [
        ['npm', 'i', '-g', '--prefix', path.join(homedir, '.local'), '@openai/codex@0.164.0'],
        ['ln', '-sf', path.join(worktree, 'bin', 'omni.js'), path.join(homedir, '.local', 'bin', 'omni')],
    ];
}

module.exports = { codexPathCandidates, resolveCodexPath, agyPathCandidates, resolveAgyPath, resolveClaudeCommand, restoreCommands };
