'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBinary } = require('../lib/squad/runtimes/resolve-binary');
const { fakeFs } = require('./helpers/squad-fakes');

const binary = {
    name: 'tool',
    envOverride: 'OMNI_TOOL_PATH',
    extraCandidates: (ctx) => (ctx.platform === 'win32' ? ['C:\\Users\\me\\tool\\tool.exe'] : ['/home/me/.local/bin/tool']),
};
const posix = (files, env = {}) => ({ platform: 'linux', homedir: '/home/me', env: { PATH: '/usr/bin:/opt/bin', ...env }, fsImpl: fakeFs(files) });
const win = (files, env = {}) => ({
    platform: 'win32', homedir: 'C:\\Users\\me', execPath: 'C:\\node\\node.exe',
    env: { PATH: 'C:\\bin;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env }, fsImpl: fakeFs(files),
});

test('env override wins over every other candidate', () => {
    const r = resolveBinary(binary, posix({ '/custom/tool': '', '/home/me/.local/bin/tool': '' }, { OMNI_TOOL_PATH: ' /custom/tool ' }));
    assert.deepEqual([r.found, r.command, r.source], [true, '/custom/tool', 'env']);
});

test('a missing override is reported instead of falling through', () => {
    const r = resolveBinary(binary, posix({ '/home/me/.local/bin/tool': '' }, { OMNI_TOOL_PATH: '/custom/tool' }));
    assert.equal(r.found, false);
    assert.equal(r.code, 'SQUAD_RUNTIME_NOT_FOUND');
    assert.match(r.reason, /OMNI_TOOL_PATH/);
});

test('adapter candidates come before PATH', () => {
    const r = resolveBinary(binary, posix({ '/home/me/.local/bin/tool': '', '/usr/bin/tool': '' }));
    assert.deepEqual([r.path, r.source], ['/home/me/.local/bin/tool', 'candidate']);
});

test('POSIX PATH lookup', () => {
    const r = resolveBinary(binary, posix({ '/opt/bin/tool': '' }));
    assert.deepEqual([r.found, r.path, r.source, r.prefixArgs], [true, '/opt/bin/tool', 'path', []]);
});

test('Windows PATH lookup applies PATHEXT', () => {
    const r = resolveBinary(binary, win({ 'C:\\bin\\tool.exe': '' }));
    assert.deepEqual([r.found, r.command, r.source], [true, 'C:\\bin\\tool.exe', 'path']);
});

test('Windows npm cmd-shim resolves to node + script, never a shell', () => {
    const shim = '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@acme\\tool\\bin\\tool.js" %*\r\n';
    const script = 'C:\\npm\\node_modules\\@acme\\tool\\bin\\tool.js';
    const r = resolveBinary(binary, win({ 'C:\\npm\\tool.cmd': shim, [script]: '' }));
    assert.deepEqual([r.found, r.command, r.prefixArgs, r.source], [true, 'C:\\node\\node.exe', [script], 'shim']);
});

test('a real npm shim that also names node.exe still picks the .js entrypoint', () => {
    const shim = [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join('\r\n');
    const script = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    const r = resolveBinary(binary, win({ 'C:\\npm\\tool.cmd': shim, 'C:\\npm\\node.exe': '', [script]: '' }));
    assert.deepEqual([r.command, r.prefixArgs], ['C:\\node\\node.exe', [script]]);
});

test('a cmd-shim pointing at an .exe resolves to the .exe', () => {
    const shim = '@"%~dp0\\vendor\\tool.exe" %*\r\n';
    const r = resolveBinary(binary, win({ 'C:\\npm\\tool.cmd': shim, 'C:\\npm\\vendor\\tool.exe': '' }));
    assert.deepEqual([r.found, r.command, r.prefixArgs], [true, 'C:\\npm\\vendor\\tool.exe', []]);
});

test('an unresolvable shim fails with SQUAD_RUNTIME_WINDOWS_SHIM', () => {
    const r = resolveBinary(binary, win({ 'C:\\npm\\tool.cmd': '@echo off\r\ncall something.bat\r\n' }));
    assert.equal(r.found, false);
    assert.equal(r.code, 'SQUAD_RUNTIME_WINDOWS_SHIM');
});

test('not found lists everything searched', () => {
    const r = resolveBinary(binary, posix({}));
    assert.equal(r.code, 'SQUAD_RUNTIME_NOT_FOUND');
    assert.deepEqual(r.searched, ['/home/me/.local/bin/tool', '/usr/bin/tool', '/opt/bin/tool']);
});
