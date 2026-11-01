'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const claude = require('../lib/squad/runtimes/claude');
const { defaultRegistry, probeContext } = require('../lib/squad/runtimes');
const { EvidenceSchema } = require('../lib/dual/contracts');
const { fakeSpawn, fakeFs } = require('./helpers/squad-fakes');

const resolved = { found: true, command: '/bin/claude', prefixArgs: [], path: '/bin/claude', source: 'candidate' };
const ctxWith = (spawnScript, env = {}) => probeContext({ platform: 'linux', homedir: '/home/me', env, resolved, spawnImpl: fakeSpawn(spawnScript) });
const turn = { prompt: 'look around', cwd: '/work', model: 'sonnet', effort: 'low', permission: 'read-only', timeoutMs: 120_000 };
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'squad-cli', name), 'utf8');

test('claude is registered next to codex and agy', () => {
    assert.deepEqual(defaultRegistry.list().map((r) => r.id), ['codex', 'agy', 'claude']);
    assert.equal(defaultRegistry.get('claude').displayName, 'Claude Code');
});

test('version parses claude --version', async () => {
    const v = await claude.version(ctxWith(() => ({ stdout: '2.1.316 (Claude Code)\n' })));
    assert.deepEqual([v.ok, v.version], [true, '2.1.316']);
    assert.equal((await claude.version(ctxWith(() => ({ stdout: 'hello' })))).code, 'SQUAD_RUNTIME_PARSE_FAILED');
});

test('auth status: real signed-in JSON, signed out, unreadable', async () => {
    const yes = await claude.authStatus(ctxWith(() => ({ stdout: fixture('claude-auth-status.json') })));
    assert.deepEqual([yes.state, yes.method], ['authenticated', 'claude.ai']);
    const no = await claude.authStatus(ctxWith(() => ({ stdout: '{"loggedIn":false}', code: 1 })));
    assert.deepEqual([no.state, no.fix], ['unauthenticated', 'chạy: claude auth login']);
    assert.equal((await claude.authStatus(ctxWith(() => ({ stderr: 'boom', code: 2 })))).state, 'unknown');
});

test('models come from `claude -p /model` (V31), else a static alias list', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: fixture('claude-slash-model.json') }));
    const r = await claude.listModels(probeContext({ platform: 'linux', homedir: '/home/me', env: {}, resolved, spawnImpl }));
    assert.equal(r.source, 'cli');
    assert.deepEqual(r.models.map((m) => m.id),
        ['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan', 'default']);
    assert.deepEqual(r.models[0], { id: 'sonnet', label: 'sonnet', family: 'anthropic',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null });
    assert.deepEqual(spawnImpl.calls[0].args.slice(0, 3), ['-p', '/model', '--output-format']);
    const fallback = await claude.listModels(ctxWith(() => ({ stdout: '{"type":"result","result":"no list here"}' })));
    assert.deepEqual([fallback.ok, fallback.source, fallback.models.map((m) => m.id)], [true, 'static', ['fable', 'opus', 'sonnet', 'haiku']]);
    const failed = await claude.listModels(ctxWith(() => ({ code: 1, stderr: 'nope' })));
    assert.deepEqual([failed.ok, failed.source], [true, 'static']);
    assert.match(failed.note, /nope/);
});

// V25/R1/R2: permission modes do not limit tools; the profile is a --tools list.
test('permission profiles are tool lists; plan mode is never used', () => {
    assert.deepEqual(claude.permissionFlags('read-only'), ['--tools', 'Read,Grep,Glob,Skill', '--permission-prompts', 'none']);
    assert.deepEqual(claude.permissionFlags('workspace-write'),
        ['--permission-mode', 'acceptEdits', '--tools', 'Read,Grep,Glob,Skill,Edit,Write', '--permission-prompts', 'none']);
    assert.deepEqual(claude.permissionFlags('full-auto', { isolatedRoot: true }),
        ['--permission-mode', 'bypassPermissions', '--permission-prompts', 'none']);
    for (const profile of ['read-only', 'workspace-write']) {
        const flags = claude.permissionFlags(profile).join(' ');
        assert.doesNotMatch(flags, /plan|Bash|bypass/);
    }
});

test('buildHeadless argv (golden): schema text inline, compacted (V24)', () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const fsImpl = fakeFs({ '/work/s.json': JSON.stringify(schema, null, 2) });
    const inv = claude.buildHeadless({ ...turn, addDirs: ['/extra'], jsonSchemaPath: '/work/s.json' }, { resolved, fsImpl });
    assert.equal(inv.command, '/bin/claude');
    assert.deepEqual(inv.args, [
        '-p', 'look around', '--output-format', 'json', '--model', 'sonnet', '--effort', 'low',
        '--tools', 'Read,Grep,Glob,Skill', '--permission-prompts', 'none', '--add-dir', '/extra',
        '--json-schema', JSON.stringify(schema),
    ]);
    assert.equal(inv.cwd, '/work');
});

test('a bad or oversized schema file is a bad turn', () => {
    const build = (files) => () => claude.buildHeadless({ ...turn, jsonSchemaPath: '/work/s.json' }, { resolved, fsImpl: fakeFs(files) });
    assert.throws(build({}), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    assert.throws(build({ '/work/s.json': '[1]' }), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    assert.throws(build({ '/work/s.json': JSON.stringify({ pad: 'x'.repeat(64 * 1024) }) }), { code: 'SQUAD_RUNTIME_BAD_TURN' });
});

test('buildResume appends --resume to the same flags', () => {
    const inv = claude.buildResume('9ae7cc82-ff4e-48e4-89b7-84b9335e85b0', turn, { resolved });
    assert.deepEqual(inv.args.slice(-2), ['--resume', '9ae7cc82-ff4e-48e4-89b7-84b9335e85b0']);
    assert.deepEqual(inv.args.slice(0, -2), claude.buildHeadless(turn, { resolved }).args);
    assert.throws(() => claude.buildResume('bad id', turn), { code: 'SQUAD_RUNTIME_BAD_TURN' });
});

// V26/R3: no --setting-sources (it hides the worker's own skills); every ancestor's
// CLAUDE.md, CLAUDE.local.md and .claude/rules is excluded; no MCP servers.
test('isolated roots exclude every ancestor CLAUDE.md and load no MCP', () => {
    const cwd = path.resolve('/proj/.omni/runs/w/workspace');
    const isolated = { ...turn, cwd, permission: 'full-auto', isolatedRoot: true };
    for (const inv of [claude.buildHeadless(isolated, { resolved }), claude.buildResume('abc', isolated, { resolved })]) {
        assert.ok(inv.args.includes('--strict-mcp-config'));
        assert.ok(!inv.args.includes('--setting-sources') && !inv.args.includes('--mcp-config'));
        const settings = JSON.parse(inv.args[inv.args.indexOf('--settings') + 1]);
        const excludes = settings.claudeMdExcludes;
        for (const dir of [path.dirname(cwd), path.resolve('/proj'), path.parse(cwd).root]) {
            assert.ok(excludes.includes(path.join(dir, 'CLAUDE.md')), dir);
            assert.ok(excludes.includes(path.join(dir, 'CLAUDE.local.md')), dir);
            assert.ok(excludes.includes(path.join(dir, '.claude', 'rules', '**')), dir);
        }
        assert.ok(!excludes.includes(path.join(cwd, 'CLAUDE.md')), 'the worker root itself is not excluded');
    }
    assert.ok(!claude.buildHeadless(turn, { resolved }).args.includes('--settings'));
});

test('interactiveCommand argv (golden)', () => {
    const inv = claude.interactiveCommand({ model: 'opus', effort: 'high', cwd: '/work' }, { resolved });
    assert.deepEqual([inv.args, inv.cwd], [['--model', 'opus', '--effort', 'high'], '/work']);
    assert.throws(() => claude.interactiveCommand({ model: 'opus', effort: 'ultra', cwd: '/work' }), { code: 'SQUAD_RUNTIME_BAD_TURN' });
});

test('parseResult reads real claude -p json: session, prose result, usage (V23)', () => {
    const r = claude.parseResult({ exitCode: 0, stdout: fixture('claude-p-json.json') }, {});
    assert.deepEqual([r.completion, r.errorCode, r.payload], ['succeeded', null, null]);
    assert.equal(r.sessionRef, JSON.parse(fixture('claude-p-json.json')).session_id);
    assert.equal(r.usage.outputTokens, 4);
    assert.equal(r.usage.thinkingTokens, 0);
});

test('parseResult takes structured_output that passes the evidence schema (V24)', () => {
    const r = claude.parseResult({ exitCode: 0, stdout: fixture('claude-json-schema-evidence.json') }, { expectedSchema: EvidenceSchema });
    assert.deepEqual([r.completion, r.errorCode], ['succeeded', null]);
    assert.equal(r.payload.task_id, 'T-1');
});

test('parseResult: a tool left out by --tools is not a denial (R1)', () => {
    const r = claude.parseResult({ exitCode: 0, stdout: fixture('claude-readonly-tools.json') }, {});
    assert.deepEqual([r.completion, r.deniedActions], ['succeeded', []]);
});

test('parseResult: error subtypes, denials, missing payload, nonzero exit', () => {
    const base = JSON.parse(fixture('claude-p-json.json'));
    const run = (patch, exitCode = 0, opts = {}) => claude.parseResult({ exitCode, stdout: JSON.stringify({ ...base, ...patch }) }, opts);
    assert.equal(run({ subtype: 'error_max_turns', is_error: true }).errorCode, 'SQUAD_RUNTIME_TURN_FAILED');
    assert.equal(run({ subtype: 'error_max_structured_output_retries' }).errorCode, 'SQUAD_RUNTIME_TURN_FAILED');
    assert.equal(run({ permission_denials: [{ tool_name: 'Bash' }] }).errorCode, 'SQUAD_RUNTIME_DENIED_ACTIONS');
    assert.equal(run({}, 0, { expectedSchema: EvidenceSchema }).errorCode, 'SQUAD_RUNTIME_NO_PAYLOAD');
    assert.equal(run({}, 1).errorCode, 'SQUAD_RUNTIME_EXIT_NONZERO');
    assert.equal(run({ type: 'assistant' }).errorCode, 'SQUAD_RUNTIME_OUTPUT_MALFORMED');
    assert.equal(run({ subtype: undefined }).completion, 'unknown');
});

test('skill mount surface: .claude/skills and the per-user dir (CLAUDE_CONFIG_DIR aware)', () => {
    assert.deepEqual(claude.skillDirs('isolated'), ['.claude/skills']);
    assert.deepEqual(claude.userSkillDirs(probeContext({ platform: 'linux', homedir: '/home/me', env: {} })), ['/home/me/.claude/skills']);
    assert.deepEqual(claude.userSkillDirs(probeContext({ platform: 'linux', homedir: '/home/me', env: { CLAUDE_CONFIG_DIR: '/alt' } })), ['/alt/skills']);
});

test('binary candidates: ~/.local/bin and ~/.claude/local on POSIX, .exe and npm shim on win32', () => {
    const posix = claude.binary.extraCandidates({ platform: 'linux', homedir: '/home/me', env: {} });
    assert.deepEqual(posix, ['/home/me/.local/bin/claude', '/home/me/bin/claude', '/home/me/.claude/local/claude']);
    const win = claude.binary.extraCandidates({ platform: 'win32', homedir: 'C:\\Users\\me', env: { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } });
    assert.deepEqual(win, ['C:\\Users\\me\\.local\\bin\\claude.exe', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd']);
});
