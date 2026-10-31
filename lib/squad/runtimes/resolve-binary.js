'use strict';

// Cross-OS binary lookup (SPEC-SQUAD-P1 §3): env override → adapter candidates
// → PATH (+PATHEXT on Windows). Windows .cmd/.bat npm shims are resolved to
// `node <script>.js` or the real .exe, because Node refuses to spawn them with
// shell:false — and squad never falls back to shell:true.

const path = require('node:path');
const { probeContext } = require('./contract');

const MAX_SHIM_BYTES = 16 * 1024;
const SHIM_TARGET = /%~?dp0%?\\?([^"%\r\n]+?\.(js|exe))/gi;

function isFile(fsImpl, candidate) {
    try {
        return fsImpl.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function notFound(code, reason, searched) {
    return { found: false, code, reason, searched };
}

function resolveShim(shimPath, ctx, pathApi) {
    let text = '';
    try {
        const stat = ctx.fsImpl.statSync(shimPath);
        if (stat.size <= MAX_SHIM_BYTES) text = String(ctx.fsImpl.readFileSync(shimPath, 'utf8'));
    } catch {
        text = '';
    }
    // npm shims also mention "%dp0%\node.exe" (the interpreter), so a .js
    // entrypoint wins; an .exe only counts when it is not node.exe itself.
    const targets = [...text.matchAll(SHIM_TARGET)]
        .map((m) => ({ target: pathApi.join(pathApi.dirname(shimPath), m[1]), kind: m[2].toLowerCase() }))
        .filter((t) => isFile(ctx.fsImpl, t.target));
    const script = targets.find((t) => t.kind === 'js');
    if (script) return { found: true, command: ctx.execPath, prefixArgs: [script.target], path: script.target, source: 'shim' };
    const exe = targets.find((t) => t.kind === 'exe' && !/(^|\\)node\.exe$/i.test(t.target));
    if (exe) return { found: true, command: exe.target, prefixArgs: [], path: exe.target, source: 'shim' };
    return notFound('SQUAD_RUNTIME_WINDOWS_SHIM',
        `${shimPath} is a .cmd/.bat shim that could not be resolved to a .js or .exe target`, [shimPath]);
}

function resolveBinary(binary, rawCtx) {
    const ctx = probeContext(rawCtx);
    const win = ctx.platform === 'win32';
    const pathApi = win ? path.win32 : path.posix;
    const searched = [];
    const finish = (candidate, source) => {
        if (win && /\.(cmd|bat)$/i.test(candidate)) {
            const shim = resolveShim(candidate, ctx, pathApi);
            return shim.found ? shim : { ...shim, searched: [...searched] };
        }
        return { found: true, command: candidate, prefixArgs: [], path: candidate, source };
    };

    const override = ctx.env[binary.envOverride];
    if (typeof override === 'string' && override.trim()) {
        const candidate = override.trim();
        searched.push(candidate);
        // A wrong override must surface, not silently fall through to another binary.
        return isFile(ctx.fsImpl, candidate)
            ? finish(candidate, 'env')
            : notFound('SQUAD_RUNTIME_NOT_FOUND', `${binary.envOverride} points to a missing file: ${candidate}`, searched);
    }

    const extra = typeof binary.extraCandidates === 'function' ? binary.extraCandidates(ctx) : [];
    for (const candidate of extra) {
        searched.push(candidate);
        if (isFile(ctx.fsImpl, candidate)) return finish(candidate, 'candidate');
    }

    const pathValue = ctx.env.PATH ?? ctx.env.Path ?? '';
    const dirs = String(pathValue).split(pathApi.delimiter).filter(Boolean);
    const exts = win
        ? [...new Set(String(ctx.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
            .flatMap((ext) => [ext.toLowerCase(), ext]))]
        : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = pathApi.join(dir, binary.name + ext);
            searched.push(candidate);
            if (isFile(ctx.fsImpl, candidate)) return finish(candidate, 'path');
        }
    }
    return notFound('SQUAD_RUNTIME_NOT_FOUND', `${binary.name} was not found`, searched);
}

module.exports = { resolveBinary };
