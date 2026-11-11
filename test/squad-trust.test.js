'use strict';

// O3 (docs/SQUAD-ORCA-ADOPTION.md): report an interactive orchestrator CLI that
// will stop on its "trust this folder" prompt. Read-only: omni never edits it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectTrust, readCodexProjectTrust } = require('../lib/squad/trust');

function home(t) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-trust-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'work', 'app', 'sub'), { recursive: true });
    return dir;
}
const claudeJson = (dir, projects) => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ projects }));
const codexToml = (dir, text) => { fs.mkdirSync(path.join(dir, '.codex'), { recursive: true }); fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), text); };
const noGit = () => null;

test('claude: trust is keyed on the main repository root of a git project', (t) => {
    const dir = home(t);
    const app = path.join(dir, 'work', 'app');
    const gitInfo = () => ({ root: path.join(app, 'sub'), mainRoot: app });
    claudeJson(dir, { [app]: { hasTrustDialogAccepted: true } });
    const opts = { homedir: dir, env: {}, gitInfo };
    assert.equal(projectTrust('claude', path.join(app, 'sub'), opts).status, 'trusted');
    claudeJson(dir, { [path.join(app, 'sub')]: { hasTrustDialogAccepted: true } });
    const r = projectTrust('claude', path.join(app, 'sub'), opts);
    assert.equal(r.status, 'untrusted');
    assert.equal(r.key, app);
    assert.match(r.fix, /claude/);
});

test('claude: outside git a trusted parent folder covers the project; CLAUDE_CONFIG_DIR is honoured', (t) => {
    const dir = home(t);
    const cfg = path.join(dir, 'cfg');
    fs.mkdirSync(cfg);
    claudeJson(cfg, { [path.join(dir, 'work')]: { hasTrustDialogAccepted: true } });
    const opts = { homedir: dir, env: { CLAUDE_CONFIG_DIR: cfg }, gitInfo: noGit };
    assert.equal(projectTrust('claude', path.join(dir, 'work', 'app'), opts).status, 'trusted');
    assert.equal(projectTrust('claude', path.join(dir, 'work', 'app'), { ...opts, env: {} }).status, 'unknown', 'no ~/.claude.json');
});

test('codex: exact match on the folder or git root only, explicit untrusted wins, parents do not count', (t) => {
    const dir = home(t);
    const app = path.join(dir, 'work', 'app');
    const opts = { homedir: dir, env: {}, gitInfo: () => ({ root: app, mainRoot: app }) };
    codexToml(dir, `model = "x"\n[projects."${dir}"]\ntrust_level = "trusted"\n`);
    assert.equal(projectTrust('codex', path.join(app, 'sub'), opts).status, 'untrusted');
    codexToml(dir, `[projects."${app}"]\ntrust_level = "trusted"\n\n[features]\nhooks = true\n`);
    assert.equal(projectTrust('codex', path.join(app, 'sub'), opts).status, 'trusted');
    codexToml(dir, `[projects."${path.join(app, 'sub')}"]\ntrust_level = "untrusted"\n[projects."${app}"]\ntrust_level = "trusted"\n`);
    assert.equal(projectTrust('codex', path.join(app, 'sub'), opts).status, 'untrusted');
    // a linked worktree is covered by its main checkout's trust
    codexToml(dir, `[projects."${dir}"]\ntrust_level = "trusted"\n`);
    assert.equal(projectTrust('codex', app, { ...opts, gitInfo: () => ({ root: app, mainRoot: dir }) }).status, 'trusted');
    // no git and no .codex: projectless, no prompt
    assert.equal(projectTrust('codex', app, { ...opts, gitInfo: noGit }).status, 'not_needed');
});

test('codex config reader: quoted keys with escapes; anything it cannot read is unknown, not trusted', () => {
    const map = readCodexProjectTrust('[projects."/a \\"b\\""]\ntrust_level = "trusted"\n[projects.\'/c\']\ntrust_level = "untrusted"\n');
    assert.deepEqual(map, { '/a "b"': 'trusted', '/c': 'untrusted' });
    assert.equal(readCodexProjectTrust('projects = { "/a" = { trust_level = "trusted" } }'), null);
});

test('runtimes without a trust prompt are not_needed', () => {
    assert.equal(projectTrust('agy', '/x', { homedir: '/h', env: {}, gitInfo: noGit }).status, 'not_needed');
});
