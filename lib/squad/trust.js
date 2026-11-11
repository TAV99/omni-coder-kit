'use strict';

// O3 (docs/SQUAD-ORCA-ADOPTION.md): will the interactive orchestrator CLI stop
// on its "trust this folder" prompt? Read-only — omni never edits a CLI's trust
// store; it tells the person the one-time step. Headless (-p / exec) turns do
// not show the prompt, so only the orchestrator is checked.
//
// claude (code.claude.com/docs/en/permissions, "Project allow rules and
// workspace trust"): keyed on the git repository root (the main checkout's for
// a worktree); outside git on the start folder, and a trusted parent folder
// covers its subfolders. Stored as projects[key].hasTrustDialogAccepted in
// ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json).
//
// codex (codex-rs config loader, decision_for_dir): exact match on the folder,
// the project root or the git repo root (the main checkout's for a worktree)
// — no parent walk; a folder with no git and no .codex needs no trust. Stored as
// [projects."<path>"] trust_level = "trusted" | "untrusted" in config.toml.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function defaultGitInfo(dir) {
    const run = (args) => {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 });
        return r.status === 0 ? r.stdout.trim() : null;
    };
    const root = run(['rev-parse', '--show-toplevel']);
    if (!root) return null;
    const common = run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const mainRoot = common && path.basename(common) === '.git' ? path.dirname(common) : root;
    return { root, mainRoot };
}

const real = (p, fsImpl) => { try { return fsImpl.realpathSync.native(p); } catch { return p; } };

function readJson(file, fsImpl) {
    try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; }
}

// TOML basic ("...") or literal ('...') string at the start of text.
function tomlString(text) {
    if (text[0] === "'") {
        const end = text.indexOf("'", 1);
        return end < 0 ? null : { value: text.slice(1, end), rest: text.slice(end + 1) };
    }
    if (text[0] !== '"') return null;
    let value = '';
    for (let i = 1; i < text.length; i++) {
        const c = text[i];
        if (c === '"') return { value, rest: text.slice(i + 1) };
        if (c !== '\\') { value += c; continue; }
        const n = text[++i];
        const map = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        if (map[n] === undefined) return null; // \u escapes: not worth guessing
        value += map[n];
    }
    return null;
}

// Map of project path → trust_level from the [projects."<path>"] tables codex
// writes. null when projects appear in a form this reader does not handle.
function readCodexProjectTrust(text) {
    const out = {};
    let current = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
            current = null;
            const m = /^\[\s*projects\s*\.\s*(.*)\]\s*(#.*)?$/.exec(line);
            if (!m) continue;
            const key = tomlString(m[1].trim());
            if (!key || key.rest.trim() !== '') return null;
            current = key.value;
            continue;
        }
        if (/^projects\s*[=.]/.test(line)) return null; // inline / dotted form
        if (current === null) continue;
        const m = /^trust_level\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const value = tomlString(m[1].trim());
        if (!value) return null;
        out[current] = value.value;
    }
    return out;
}

function claudeTrust(projectRoot, { homedir, env, fsImpl, gitInfo }) {
    const configDir = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim();
    const file = configDir ? path.join(configDir, '.claude.json') : path.join(homedir, '.claude.json');
    const git = gitInfo(projectRoot);
    const key = git ? git.mainRoot : projectRoot;
    const fix = `chạy "claude" trong ${key} một lần và chọn "Yes, I trust this folder"`;
    const config = readJson(file, fsImpl);
    if (!config || typeof config.projects !== 'object' || config.projects === null) return { status: 'unknown', key, fix };
    const accepted = (p) => config.projects[p]?.hasTrustDialogAccepted === true
        || config.projects[real(p, fsImpl)]?.hasTrustDialogAccepted === true;
    if (accepted(key)) return { status: 'trusted', key };
    if (!git) {
        // A trusted parent covers its subfolders; the home folder is session-only.
        for (let dir = path.dirname(key); dir !== path.dirname(dir); dir = path.dirname(dir)) {
            if (dir === homedir) break;
            if (accepted(dir)) return { status: 'trusted', key: dir };
        }
    }
    return { status: 'untrusted', key, fix };
}

function codexTrust(projectRoot, { homedir, env, fsImpl, gitInfo }) {
    const home = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(homedir, '.codex');
    const git = gitInfo(projectRoot);
    // Projectless (no git checkout, no project .codex): codex skips the prompt.
    if (!git && !fsImpl.existsSync(path.join(projectRoot, '.codex'))) return { status: 'not_needed' };
    // A worktree's trust key is the main repository root (resolve_root_git_project_for_trust).
    const keys = [...new Set([projectRoot, real(projectRoot, fsImpl),
        ...(git ? [git.root, real(git.root, fsImpl), git.mainRoot, real(git.mainRoot, fsImpl)] : [])])];
    const key = git ? git.mainRoot : projectRoot;
    const fix = `chạy "codex" trong ${key} một lần và chọn tin cậy thư mục`;
    let text;
    try { text = fsImpl.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return { status: 'untrusted', key, fix }; }
    const map = readCodexProjectTrust(text);
    if (!map) return { status: 'unknown', key, fix };
    for (const candidate of keys) {
        if (map[candidate] === 'trusted') return { status: 'trusted', key: candidate };
        if (map[candidate] === 'untrusted') return { status: 'untrusted', key: candidate, explicit: true,
            fix: `${candidate} đang bị đánh dấu untrusted trong ${path.join(home, 'config.toml')} — đổi thành "trusted" nếu bạn tin thư mục này` };
    }
    return { status: 'untrusted', key, fix };
}

// → { status: 'trusted' | 'untrusted' | 'unknown' | 'not_needed', key?, fix? }
function projectTrust(runtimeId, projectRoot, { homedir, env = process.env, fsImpl = fs, gitInfo = defaultGitInfo } = {}) {
    const opts = { homedir, env, fsImpl, gitInfo };
    if (runtimeId === 'claude') return claudeTrust(projectRoot, opts);
    if (runtimeId === 'codex') return codexTrust(projectRoot, opts);
    return { status: 'not_needed' };
}

module.exports = { projectTrust, readCodexProjectTrust };
