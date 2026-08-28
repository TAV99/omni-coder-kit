'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
    createDaemonClient,
    DualDaemonClientError,
} = require('./daemon-client');

class DualHookBridgeError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualHookBridgeError';
        this.code = code;
        this.details = details;
    }
}

const ALLOWED_EVENT_NAMES = new Set([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
]);

function quoteWindowsCommandLineArg(value) {
    const text = String(value);
    if (text.length === 0) return '""';
    if (!/[\s"]/u.test(text)) return text;

    let quoted = '"';
    let backslashes = 0;
    for (const char of text) {
        if (char === '\\') {
            backslashes++;
            continue;
        }
        if (char === '"') {
            quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
            backslashes = 0;
            continue;
        }
        quoted += '\\'.repeat(backslashes) + char;
        backslashes = 0;
    }
    quoted += '\\'.repeat(backslashes * 2) + '"';
    return quoted;
}

function quotePowerShellLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function spawnDaemonProcess({
    workspaceRoot,
    daemonEntrypoint,
    spawnImpl = spawn,
    platform = process.platform,
}) {
    if (platform === 'win32') {
        const argumentLine = [daemonEntrypoint, '--workspace', workspaceRoot]
            .map(quoteWindowsCommandLineArg)
            .join(' ');
        const startProcess = [
            `Start-Process -FilePath ${quotePowerShellLiteral(process.execPath)}`,
            `-ArgumentList ${quotePowerShellLiteral(argumentLine)}`,
            `-WorkingDirectory ${quotePowerShellLiteral(workspaceRoot)}`,
            '-WindowStyle Hidden',
        ].join(' ');
        const script = `$ErrorActionPreference = 'Stop'; ${startProcess}`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        return spawnImpl('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            encoded,
        ], {
            cwd: workspaceRoot,
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
        });
    }

    const child = spawnImpl(process.execPath, [daemonEntrypoint, '--workspace', workspaceRoot], {
        cwd: workspaceRoot,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
    });
    if (child && typeof child.unref === 'function') {
        child.unref();
    }
    return child;
}

const KNOWN_MCP_PATH_KEYS = new Set([
    'path',
    'paths',
    'file',
    'files',
    'file_path',
    'file_paths',
    'filepath',
    'filepaths',
    'dest',
    'dests',
    'destination',
    'destinations',
    'target',
    'targets',
    'targetpath',
    'targetpaths',
    'target_path',
    'target_paths',
    'targetfile',
    'targetfiles',
    'target_file',
    'target_files',
    'to',
    'src',
    'srcs',
    'source',
    'sources',
    'outputpath',
    'outputpaths',
    'output_path',
    'output_paths',
    'target_dir',
    'target_dirs',
    'dir',
    'dirs',
    'directory',
    'directories',
]);

const READ_VERBS = new Set([
    'read',
    'get',
    'fetch',
    'list',
    'view',
    'search',
    'find',
    'inspect',
    'show',
    'status',
    'describe',
    'query',
    'check',
    'cat',
    'load',
    'select',
    'count',
    'js',
    'eval',
    'repl',
    'browse',
    'navigate',
    'screenshot',
    'render',
    'click',
    'scroll',
    'hover',
    'type',
    'press',
    'audit',
    'test',
    'lint',
    'verify',
    'preview',
    'open',
    'close',
    'console',
    'network',
    'page',
    'dom',
    'element',
    'node',
    'capture',
    'snapshot',
    'viewport',
    'evaluate',
    'wait',
    'fill',
    'focus',
    'mouse',
    'keyboard',
    'drag',
    'resize',
    'emulate',
    'device',
    'metrics',
    'accessibility',
    'a11y',
    'trace',
    'profiler',
]);

const MUTATING_VERBS = new Set([
    'write',
    'edit',
    'create',
    'delete',
    'move',
    'rename',
    'patch',
    'apply',
    'execute',
    'run',
    'update',
    'remove',
    'make',
    'save',
    'put',
    'post',
    'append',
    'insert',
    'replace',
    'set',
    'destroy',
    'unlink',
    'erase',
    'modify',
    'touch',
    'truncate',
]);

const MAX_RECURSION_DEPTH = 5;
const MAX_VISITED_NODES = 200;
const MAX_EXTRACTED_PATHS = 50;
const MAX_STRING_FIELD_LEN = 1024;
const MAX_STDOUT_BYTES = 16 * 1024; // 16 KiB

function validateHookInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'Input must be a non-null object');
    }

    if (typeof input.session_id !== 'string' || input.session_id.trim().length === 0) {
        throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'session_id is required and must be a non-empty string');
    }

    if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
        throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'cwd is required and must be a non-empty string');
    }

    if (typeof input.hook_event_name !== 'string' || input.hook_event_name.trim().length === 0) {
        throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'hook_event_name is required and must be a non-empty string');
    }

    const eventName = input.hook_event_name.trim();

    if (!ALLOWED_EVENT_NAMES.has(eventName)) {
        throw new DualHookBridgeError(
            'DUAL_HOOK_INPUT_INVALID',
            'Unsupported hook_event_name'
        );
    }

    if (eventName === 'PreToolUse') {
        if (typeof input.tool_name !== 'string' || input.tool_name.trim().length === 0) {
            throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'tool_name is required for PreToolUse');
        }
        if (!input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) {
            throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'tool_input is required for PreToolUse');
        }
    } else if (eventName === 'PostToolUse') {
        if (typeof input.tool_name !== 'string' || input.tool_name.trim().length === 0) {
            throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'tool_name is required for PostToolUse');
        }
        if (!input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) {
            throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'tool_input is required for PostToolUse');
        }
        if (input.tool_response === undefined) {
            throw new DualHookBridgeError('DUAL_HOOK_INPUT_INVALID', 'tool_response is required for PostToolUse');
        }
    }

    return {
        session_id: input.session_id,
        cwd: input.cwd,
        hook_event_name: eventName,
        turn_id: typeof input.turn_id === 'string' ? input.turn_id : undefined,
        tool_name: typeof input.tool_name === 'string' ? input.tool_name : undefined,
        tool_use_id: typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined,
        tool_input: input.tool_input,
        tool_response: input.tool_response,
        stop_hook_active: Boolean(input.stop_hook_active),
        source: typeof input.source === 'string' ? input.source : undefined,
    };
}

function cleanAndValidateRepoPath(candidate, { workspaceRoot } = {}) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
        throw new DualHookBridgeError('DUAL_PATH_INVALID', 'Path must be a non-empty string without NUL bytes');
    }

    let cleaned = candidate.trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1).trim();
    }

    const isWindowsAbsolute = path.win32.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith('\\');
    const isPosixAbsolute = path.posix.isAbsolute(cleaned);
    if (isWindowsAbsolute || isPosixAbsolute) {
        if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
            throw new DualHookBridgeError('DUAL_PATH_INVALID', 'Absolute repository path requires a workspace root');
        }
        const rootIsWindows = path.win32.isAbsolute(workspaceRoot) || /^[a-zA-Z]:/.test(workspaceRoot) || workspaceRoot.startsWith('\\');
        if (rootIsWindows !== isWindowsAbsolute) {
            throw new DualHookBridgeError('DUAL_PATH_INVALID', 'Absolute repository path uses a different platform root');
        }
        const pathApi = isWindowsAbsolute ? path.win32 : path.posix;
        const canonicalRoot = pathApi.resolve(workspaceRoot);
        const canonicalTarget = pathApi.resolve(cleaned);
        const relative = pathApi.relative(canonicalRoot, canonicalTarget);
        if (
            relative.length === 0 ||
            relative === '..' ||
            relative.startsWith(`..${pathApi.sep}`) ||
            pathApi.isAbsolute(relative)
        ) {
            throw new DualHookBridgeError('DUAL_PATH_INVALID', 'Absolute repository path is outside the workspace');
        }
        cleaned = relative;
    }

    const slashPath = cleaned.replace(/\\/g, '/');
    const segments = slashPath.split('/');
    if (segments.some((seg) => seg === '..')) {
        throw new DualHookBridgeError('DUAL_PATH_INVALID', `Path traversal is forbidden`);
    }

    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
        throw new DualHookBridgeError('DUAL_PATH_INVALID', `Invalid repository path`);
    }

    return normalized;
}

const EXACT_FRAMING_LINES = new Set([
    '*** Begin Patch',
    '*** End Patch',
    '*** End of File',
]);

function extractPatchPaths(commandOrText, options = {}) {
    if (typeof commandOrText !== 'string' || commandOrText.trim().length === 0) {
        return [];
    }

    const lines = commandOrText.split(/\r?\n/);
    const paths = new Set();

    const patchHeaderPattern = /^\*\*\*\s+(Add File|Update File|Delete File|Move to):(.*)$/;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('***')) {
            if (EXACT_FRAMING_LINES.has(line)) {
                continue;
            }

            const match = patchHeaderPattern.exec(line);
            if (match) {
                const rawPath = match[2].trim();
                if (rawPath.length === 0) {
                    throw new DualHookBridgeError('DUAL_PATCH_INVALID', 'Patch header has empty path');
                }
                const validPath = cleanAndValidateRepoPath(rawPath, options);
                paths.add(validPath);
            } else {
                throw new DualHookBridgeError(
                    'DUAL_PATCH_INVALID',
                    'Malformed or unsupported patch header'
                );
            }
        }
    }

    return Array.from(paths).sort();
}

function extractMcpPaths(toolInput, options = {}) {
    if (!toolInput || typeof toolInput !== 'object') {
        return [];
    }

    const state = {
        visited: 0,
        collected: new Set(),
    };

    function traverse(node, depth, isUnderKnownKey) {
        if (!node || typeof node !== 'object') {
            if (isUnderKnownKey && typeof node === 'string') {
                const valid = cleanAndValidateRepoPath(node, options);
                state.collected.add(valid);
                if (state.collected.size > MAX_EXTRACTED_PATHS) {
                    throw new DualHookBridgeError(
                        'DUAL_MCP_BOUNDS_EXCEEDED',
                        `MCP path extraction exceeded maximum path count (${MAX_EXTRACTED_PATHS})`
                    );
                }
            }
            return;
        }

        state.visited++;
        if (state.visited > MAX_VISITED_NODES || depth > MAX_RECURSION_DEPTH) {
            throw new DualHookBridgeError(
                'DUAL_MCP_BOUNDS_EXCEEDED',
                'MCP path extraction exceeded recursion depth or node limit'
            );
        }

        if (Array.isArray(node)) {
            for (const elem of node) {
                if (typeof elem === 'string') {
                    if (isUnderKnownKey) {
                        const valid = cleanAndValidateRepoPath(elem);
                        state.collected.add(valid);
                        if (state.collected.size > MAX_EXTRACTED_PATHS) {
                            throw new DualHookBridgeError(
                                'DUAL_MCP_BOUNDS_EXCEEDED',
                                `MCP path extraction exceeded maximum path count (${MAX_EXTRACTED_PATHS})`
                            );
                        }
                    }
                    // String under unknown key array is ignored (never collected)
                } else if (typeof elem === 'object' && elem !== null) {
                    traverse(elem, depth + 1, isUnderKnownKey);
                }
            }
        } else {
            for (const [key, value] of Object.entries(node)) {
                const lowerKey = key.toLowerCase();
                const isKnown = KNOWN_MCP_PATH_KEYS.has(lowerKey);
                traverse(value, depth + 1, isKnown);
            }
        }
    }

    traverse(toolInput, 0, false);
    return Array.from(state.collected).sort();
}

const EVENT_HINT_PATTERN = /["']hook_event_name["']\s*:\s*["'](SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop)["']/;

function extractEventHint(chunkOrPrefix) {
    if (typeof chunkOrPrefix !== 'string' && !Buffer.isBuffer(chunkOrPrefix)) {
        return null;
    }
    const prefixStr = typeof chunkOrPrefix === 'string'
        ? chunkOrPrefix.slice(0, 4096)
        : chunkOrPrefix.toString('utf8', 0, Math.min(chunkOrPrefix.length, 4096));

    const match = EVENT_HINT_PATTERN.exec(prefixStr);
    return match ? match[1] : null;
}

function safeTokenizeBash(commandStr) {
    if (typeof commandStr !== 'string') return [];
    const tokens = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < commandStr.length; i++) {
        const char = commandStr[i];
        if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        } else if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
        } else if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
}

function tokenizeMcpAction(actionName) {
    if (typeof actionName !== 'string') return [];
    return actionName
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split(/[_\-.\s]+/)
        .filter(Boolean)
        .slice(0, 20);
}

function validateSetupFlags(flags) {
    const allowedFlags = new Set(['--dry-run', '--force', '--json']);
    const seen = new Set();

    for (const flag of flags) {
        if (!allowedFlags.has(flag)) {
            return false;
        }
        if (seen.has(flag)) {
            return false; // Reject duplicates
        }
        seen.add(flag);
    }
    return true;
}

function validateDualInspectionArgs(args) {
    if (!Array.isArray(args)) return false;
    if (args.length === 2 && args[0] === 'dual' && (args[1] === '--help' || args[1] === '-h')) return true;
    if (args.length === 2 && args[0] === 'dual' && (args[1] === 'status' || args[1] === 'qc')) return true;
    if (args.length === 3 && args[0] === 'dual' && (args[1] === 'status' || args[1] === 'qc')) {
        return args[2] === '--json' || /^(TASK-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(args[2]);
    }
    if (args.length === 4 && args[0] === 'dual' && (args[1] === 'status' || args[1] === 'qc')) {
        return /^(TASK-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(args[2]) && args[3] === '--json';
    }
    if (args.length >= 3 && args[0] === 'dual' && (args[1] === 'phase' || args[1] === 'run' || args[1] === 'resume')) {
        const validPhases = new Set(['scout', 'spec', 'implement', 'review', 'scope']);
        if (args[1] === 'phase') {
            return validPhases.has(args[2]) && (args.length === 3 || (args.length === 4 && /^(TASK-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(args[3])));
        }
        return true;
    }
    if (args.length >= 2 && args[0] === 'dual' && args[1] === 'daemon') {
        const sub = args[2];
        return ['status', 'stop', 'start'].includes(sub);
    }
    return false;
}

function validateDualRecoveryArgs(args) {
    if (!Array.isArray(args) || args[0] !== 'dual' || args[1] !== 'daemon' || args[2] !== 'recover') return false;
    const flags = args.slice(3);
    if (!flags.includes('--if-pristine')) return false;
    const allowed = new Set(['--if-pristine', '--json']);
    return flags.length >= 1 && flags.length <= 2 && flags.every((flag) => allowed.has(flag)) && new Set(flags).size === flags.length;
}

function validateDualBootstrapArgs(args) {
    if (!Array.isArray(args) || args[0] !== 'dual' || args[1] !== 'bootstrap') return false;
    const flags = args.slice(2);
    return flags.length === 0 || (flags.length === 1 && flags[0] === '--json');
}

function validateSkillsArgs(args) {
    if (!Array.isArray(args)) return false;
    if (args.length === 0) return true;
    if (args.length === 1) return args[0] === '-y' || args[0] === '--yes' || args[0] === '--help' || args[0] === '-h' || args[0] === 'list';
    if (args[0] === 'find' || args[0] === 'search') return true;
    if (args[0] !== 'add' && args[0] !== 'install') return false;

    const rest = args.slice(1);
    const nonFlags = rest.filter((a) => typeof a === 'string' && !a.startsWith('-'));
    const flags = rest.filter((a) => typeof a === 'string' && a.startsWith('-'));

    if (nonFlags.length !== 1) return false;
    for (const flag of flags) {
        if (flag !== '-y' && flag !== '--yes' && flag !== '--force') return false;
    }

    const source = nonFlags[0];
    if (
        typeof source !== 'string' ||
        source.length === 0 ||
        source.length > 512 ||
        /[\u0000-\u0020\u007f\\]/u.test(source)
    ) {
        return false;
    }

    // Allow standard skill names, owner/repo, gh:owner/repo, and https URLs
    if (/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._/-]+)?$/u.test(source)) {
        return !source.split('/').some((segment) => segment === '.' || segment === '..');
    }

    if (/^gh:[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/u.test(source)) {
        return !source.slice(3).split('/').some((segment) => segment === '.' || segment === '..');
    }

    try {
        const url = new URL(source);
        return (
            url.protocol === 'https:' &&
            url.hostname.length > 0 &&
            url.username.length === 0 &&
            url.password.length === 0
        );
    } catch {
        return false;
    }
}

const DUAL_CONTROL_OPERATIONS = new Set([
    'omni_dual_begin',
    'omni_dual_register_plan',
    'omni_dual_status',
    'omni_dual_resume',
    'omni_dual_completion',
]);

function isPreAuthorityPlanningPath(candidate) {
    const normalized = String(candidate || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.startsWith('.omni/sdlc/') || normalized.startsWith('.omni/knowledge/')) {
        return true;
    }
    return (
        /^docs\/superpowers\/plans\/[a-zA-Z0-9._-]+\.md$/u.test(normalized) ||
        normalized.startsWith('.agents/skills/') ||
        normalized.startsWith('.codex/skills/') ||
        normalized.startsWith('.omni/skills/')
    );
}

function isDesignReady(workspaceRoot, fsImpl = fs) {
    const designPath = path.join(workspaceRoot, '.omni', 'sdlc', 'design-spec.md');
    try {
        if (!fsImpl.existsSync(designPath)) return false;
        const stat = fsImpl.statSync(designPath);
        return stat.isFile() && stat.size > 0;
    } catch {
        return true;
    }
}

function evaluatePreAuthorityPhase(input, workspaceRoot, fsImpl = fs) {
    if (!isDesignReady(workspaceRoot, fsImpl)) return null;

    if (input.hook_event_name === 'PreToolUse') {
        const classification = classifyTool(input.tool_name, input.tool_input, { workspaceRoot });
        const allowed = (
            classification.phaseOperation === 'planning' ||
            classification.phaseOperation === 'setup' ||
            classification.phaseOperation === 'control' ||
            (classification.classification === 'read' && classification.phaseOperation !== 'verification')
        );
        if (allowed) return {};
        return sanitizeOutput({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: classification.classification === 'denied'
                    ? classification.reason
                    : '[omni-blocked] Dual session required after design is ready; finish typed setup, call omni_dual_begin, and register the plan before source/build/browser mutation',
            },
        });
    }

    if (input.hook_event_name === 'PostToolUse') {
        const classification = classifyTool(input.tool_name, input.tool_input, { workspaceRoot });
        const allowed = (
            classification.phaseOperation === 'planning' ||
            classification.phaseOperation === 'setup' ||
            classification.phaseOperation === 'control' ||
            (classification.classification === 'read' && classification.phaseOperation !== 'verification')
        );
        if (allowed) return {};
        return sanitizeOutput({
            decision: 'block',
            reason: '[omni-blocked] source/build/browser mutation occurred before Dual authority was initialized',
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: '[omni] Design is ready but Dual authority is absent. Final verification must reject this unowned mutation.',
            },
        });
    }

    if (input.hook_event_name === 'Stop') {
        if (input.stop_hook_active === true) {
            return sanitizeOutput({
                systemMessage: '[omni-blocked] Dual AUTO bootstrap remains incomplete. Stopping loop for user inspection.',
            });
        }
        return sanitizeOutput({
            decision: 'block',
            reason: '[omni] Continue AUTO through skill, plan, typed setup SUCCESS, Dual begin, and plan registration before stopping.',
        });
    }

    return null;
}

function classifyTool(toolName, toolInput = {}, options = {}) {
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
        return {
            classification: 'denied',
            reason: '[omni-blocked] tool_name is empty or invalid',
            paths: [],
        };
    }

    const trimmedName = toolName.trim();

    // 1. apply_patch (and Edit / Write aliases)
    if (trimmedName === 'apply_patch' || trimmedName === 'Edit' || trimmedName === 'Write') {
        const patchContent =
            (toolInput && (toolInput.command || toolInput.patch || toolInput.input || toolInput.content)) || '';
        let paths;
        try {
            paths = extractPatchPaths(patchContent, options);
        } catch (err) {
            return {
                classification: 'denied',
                reason: '[omni-blocked] invalid patch path or malformed patch',
                paths: [],
            };
        }

        if (!paths || paths.length === 0) {
            return {
                classification: 'denied',
                reason: '[omni-blocked] apply_patch missing valid file headers or malformed patch',
                paths: [],
            };
        }

        return {
            classification: paths.length > 1 ? 'execute' : 'write',
            paths,
            phaseOperation: paths.every(isPreAuthorityPlanningPath) ? 'planning' : 'source',
        };
    }

    // 2. Bash tool
    if (trimmedName === 'Bash') {
        const commandStr = (toolInput && (toolInput.command || toolInput.cmd || toolInput.script)) || '';
        if (typeof commandStr !== 'string' || commandStr.trim().length === 0) {
            return {
                classification: 'denied',
                reason: '[omni-blocked] Bash command is empty or invalid',
                paths: [],
            };
        }

        const trimmedCmd = commandStr.trim();

        // Check for shell chaining, operators, pipelines, and redirection
        if (/[|&;><\n\r`$]/.test(trimmedCmd)) {
            return {
                classification: 'denied',
                reason: '[omni-blocked] Bash command contains shell operators, chaining, or redirection',
                paths: [],
            };
        }

        const tokens = safeTokenizeBash(trimmedCmd);
        if (tokens.length === 0) {
            return {
                classification: 'denied',
                reason: '[omni-blocked] Bash command contains no executable tokens',
                paths: [],
            };
        }

        const prog = tokens[0].replace(/\\/g, '/');
        const progBase = path.posix.basename(prog).toLowerCase().replace(/\.exe$/, '');

        // Git inspection allowlist
        if (progBase === 'git') {
            const sub = tokens[1] ? tokens[1].toLowerCase() : '';
            const gitAllowlist = new Set(['status', 'diff', 'show', 'log', 'rev-parse']);
            if (gitAllowlist.has(sub)) {
                // Deny execution escapes across all tokens
                const hasEscape = tokens.some((t) => {
                    const lower = t.toLowerCase();
                    return (
                        lower === '--ext-diff' ||
                        lower.startsWith('--ext-diff=') ||
                        lower === '--textconv' ||
                        lower.startsWith('--textconv=') ||
                        lower === '--output' ||
                        lower.startsWith('--output=') ||
                        lower === '--exec-path' ||
                        lower.startsWith('--exec-path=') ||
                        lower === '-c' ||
                        lower.startsWith('--config-env=') ||
                        lower.startsWith('--upload-pack=') ||
                        lower.startsWith('--receive-pack=')
                    );
                });
                if (hasEscape) {
                    return {
                        classification: 'denied',
                        reason: '[omni-blocked] git command contains forbidden flags or options',
                        paths: [],
                    };
                }
                return { classification: 'read', paths: [] };
            }
            return {
                classification: 'denied',
                reason: '[omni-blocked] git subcommand is not in the read allowlist',
                paths: [],
            };
        }

        // Search allowlist (rg / grep)
        if (progBase === 'rg' || progBase === 'grep') {
            const hasEscape = tokens.some((t) => {
                const lower = t.toLowerCase();
                return (
                    lower === '--pre' ||
                    lower.startsWith('--pre=') ||
                    lower === '--pre-glob' ||
                    lower.startsWith('--pre-glob=') ||
                    lower === '--hostname-bin' ||
                    lower.startsWith('--hostname-bin=')
                );
            });
            if (hasEscape) {
                return {
                    classification: 'denied',
                    reason: '[omni-blocked] search command contains forbidden flags or options',
                    paths: [],
                };
            }
            return { classification: 'read', paths: [] };
        }

        // PowerShell / file inspect allowlist
        if (progBase === 'get-content' || progBase === 'get-childitem' || progBase === 'select-string' || progBase === 'ls' || progBase === 'dir' || progBase === 'pwd') {
            return { classification: 'read', paths: [] };
        }

        // Node allowlist
        if (progBase === 'node') {
            const sub = tokens[1] ? tokens[1].toLowerCase() : '';
            if (sub === '-c' || sub === '--check') {
                return { classification: 'read', paths: [] };
            }
            if (sub === '-e' || sub === '--eval') {
                const evalCode = tokens.slice(2).join(' ');
                if (!/child_process|spawn|exec|writeFileSync|appendFileSync|unlinkSync|rmdirSync|mkdirSync/i.test(evalCode)) {
                    return { classification: 'read', paths: [], phaseOperation: 'planning' };
                }
            }
            if (sub === '--test') {
                return { classification: 'read', paths: [], phaseOperation: 'verification' };
            }
            if (sub && (sub.startsWith('test/') || sub.startsWith('test\\') || sub.endsWith('.test.js') || sub.endsWith('.test.mjs') || sub.endsWith('.test.cjs'))) {
                return { classification: 'read', paths: [], phaseOperation: 'verification' };
            }
            const normSub = path.posix.normalize(tokens[1] ? tokens[1].replace(/\\/g, '/') : '').replace(/^\.\//, '');
            if (normSub === 'bin/omni.js' || normSub === 'bin/omni') {
                if (tokens[2] === 'dual' && tokens[3] === 'setup' && tokens[4] === 'run') {
                    const flags = tokens.slice(5);
                    if (validateSetupFlags(flags)) {
                        return { classification: 'read', paths: [], phaseOperation: 'setup' };
                    }
                    return {
                        classification: 'denied',
                        reason: '[omni-blocked] setup command contains unsupported flags or arguments',
                        paths: [],
                    };
                }
                if ((tokens[2] === 'skills' || tokens[2] === 'skill') && validateSkillsArgs(tokens.slice(3))) {
                    return { classification: 'read', paths: [], phaseOperation: 'planning' };
                }
                if (validateDualInspectionArgs(tokens.slice(2))) {
                    return { classification: 'read', paths: [], phaseOperation: 'control' };
                }
                if (validateDualRecoveryArgs(tokens.slice(2))) {
                    return { classification: 'read', paths: [], phaseOperation: 'control' };
                }
                if (validateDualBootstrapArgs(tokens.slice(2))) {
                    return { classification: 'read', paths: [], phaseOperation: 'control' };
                }
            }
            return {
                classification: 'denied',
                reason: '[omni-blocked] node invocation is not in the verified test/setup allowlist',
                paths: [],
            };
        }

        // Package manager test / typecheck / build allowlist
        if (['npm', 'pnpm', 'yarn', 'bun', 'npx'].includes(progBase)) {
            const sub1 = tokens[1] ? tokens[1].toLowerCase() : '';
            const sub2 = tokens[2] ? tokens[2].toLowerCase() : '';

            if (progBase === 'npx') {
                if ((sub1 === 'skills' || sub1 === 'skill') && validateSkillsArgs(tokens.slice(2))) {
                    return { classification: 'read', paths: [], phaseOperation: 'planning' };
                }
            }

            if (['test', 'typecheck', 'build', 'audit'].includes(sub1)) {
                return { classification: 'read', paths: [], phaseOperation: 'verification' };
            }
            if (sub1 === 'run') {
                const allowedRunTargets = new Set([
                    'test',
                    'typecheck',
                    'build',
                    'audit',
                    'dev',
                    'preview',
                    'start',
                    'test:dual',
                    'test:v4',
                    'typecheck:v4',
                    'benchmark:v4',
                    'lint',
                ]);
                if (allowedRunTargets.has(sub2)) {
                    return { classification: 'read', paths: [], phaseOperation: 'verification' };
                }
            }
            return {
                classification: 'denied',
                reason: '[omni-blocked] package manager command is not in the verification allowlist',
                paths: [],
            };
        }

        // Omni CLI inspection allowlist (exact omni dual setup run [flags])
        if (progBase === 'omni') {
            if (tokens[1] === 'dual' && tokens[2] === 'setup' && tokens[3] === 'run') {
                const flags = tokens.slice(4);
                if (validateSetupFlags(flags)) {
                    return { classification: 'read', paths: [], phaseOperation: 'setup' };
                }
                return {
                    classification: 'denied',
                    reason: '[omni-blocked] omni setup command contains unsupported flags or arguments',
                    paths: [],
                };
            }
            if ((tokens[1] === 'skills' || tokens[1] === 'skill') && validateSkillsArgs(tokens.slice(2))) {
                return { classification: 'read', paths: [], phaseOperation: 'planning' };
            }
            if (validateDualInspectionArgs(tokens.slice(1))) {
                return { classification: 'read', paths: [], phaseOperation: 'control' };
            }
            if (validateDualRecoveryArgs(tokens.slice(1))) {
                return { classification: 'read', paths: [], phaseOperation: 'control' };
            }
            if (validateDualBootstrapArgs(tokens.slice(1))) {
                return { classification: 'read', paths: [], phaseOperation: 'control' };
            }
            return {
                classification: 'denied',
                reason: '[omni-blocked] omni command is not in the planning/setup allowlist',
                paths: [],
            };
        }

        return {
            classification: 'denied',
            reason: '[omni-blocked] Bash command is not in the read/verification allowlist',
            paths: [],
        };
    }

    // 3. MCP tool names: mcp__<server>__<toolName> or mcp__<toolName>
    if (trimmedName.startsWith('mcp__')) {
        const parts = trimmedName.split('__');
        const toolAction = parts[parts.length - 1];
        const actionTokens = tokenizeMcpAction(toolAction);

        if (DUAL_CONTROL_OPERATIONS.has(toolAction.toLowerCase())) {
            return { classification: 'read', paths: [], phaseOperation: 'control' };
        }

        // Mutating verbs ALWAYS win over read verbs
        const hasMutatingVerb = actionTokens.some((tok) => MUTATING_VERBS.has(tok));
        if (hasMutatingVerb) {
            let paths;
            try {
                paths = extractMcpPaths(toolInput, options);
            } catch (err) {
                return {
                    classification: 'denied',
                    reason: '[omni-blocked] invalid MCP path or bounds exceeded',
                    paths: [],
                };
            }

            if (!paths || paths.length === 0) {
                return {
                    classification: 'denied',
                    reason: `[omni-blocked] mutating MCP tool requires declared paths`,
                    paths: [],
                };
            }

            return {
                classification: paths.length > 1 ? 'execute' : 'write',
                paths,
                phaseOperation: paths.every(isPreAuthorityPlanningPath) ? 'planning' : 'source',
            };
        }

        // Read verbs (only if no mutating verb exists)
        const hasReadVerb = actionTokens.some((tok) => READ_VERBS.has(tok));
        if (hasReadVerb) {
            return { classification: 'read', paths: [] };
        }

        return {
            classification: 'denied',
            reason: '[omni-blocked] unrecognized MCP tool fail-closed',
            paths: [],
        };
    }

    return {
        classification: 'denied',
        reason: '[omni-blocked] unknown tool fail-closed',
        paths: [],
    };
}

function inferTask(tasks, leases, declaredPaths) {
    if (!declaredPaths || !Array.isArray(declaredPaths) || declaredPaths.length === 0) {
        return {
            task: null,
            error: '[omni-blocked] mutating operation requires declared paths for task inference',
        };
    }

    const activeLeaseTaskIds = new Set();
    for (const lease of Object.values(leases || {})) {
        if (lease && lease.status === 'active' && (lease.task_id || lease.taskId)) {
            activeLeaseTaskIds.add(lease.task_id || lease.taskId);
        }
    }

    let candidates = [];
    for (const taskId of activeLeaseTaskIds) {
        const task = tasks ? tasks[taskId] : null;
        if (!task) continue;

        const allowed = (task.allowed_files || task.allowedFiles || []).map((f) => f.replace(/\\/g, '/'));
        const allFit = declaredPaths.every((p) => allowed.includes(p.replace(/\\/g, '/')));

        if (allFit) {
            candidates.push(task);
        }
    }

    if (candidates.length === 0) {
        for (const task of Object.values(tasks || {})) {
            if (!task || task.owner !== 'codex' || task.state !== 'ROUTED') continue;
            const allowed = (task.allowed_files || task.allowedFiles || []).map((f) => f.replace(/\\/g, '/'));
            const allFit = declaredPaths.every((p) => allowed.includes(p.replace(/\\/g, '/')));
            if (allFit) candidates.push(task);
        }
    }

    if (candidates.length === 0) {
        return {
            task: null,
            error: '[omni-blocked] no authorized task found for declared paths',
        };
    }

    if (candidates.length > 1) {
        const hasLeases = candidates.some((t) => activeLeaseTaskIds.has(t.task_id || t.taskId || t.id));
        if (hasLeases) {
            const ids = candidates.map((t) => t.task_id || t.taskId || t.id).join(', ');
            return {
                task: null,
                error: `[omni-blocked] ambiguous task match: multiple active tasks (${ids}) match declared paths`,
            };
        }

        // Disambiguate unleased routed tasks: prefer pending tasks and the most specific scope
        const pending = candidates.filter((t) => t.state !== 'TASK_VERIFIED');
        if (pending.length > 0) {
            pending.sort((a, b) => {
                const lenA = (a.allowed_files || a.allowedFiles || []).length;
                const lenB = (b.allowed_files || b.allowedFiles || []).length;
                return lenA - lenB;
            });
            const shortestLen = (pending[0].allowed_files || pending[0].allowedFiles || []).length;
            const tied = pending.filter((t) => (t.allowed_files || t.allowedFiles || []).length === shortestLen);
            if (tied.length === 1) {
                candidates = [tied[0]];
            } else {
                const ids = candidates.map((t) => t.task_id || t.taskId || t.id).join(', ');
                return {
                    task: null,
                    error: `[omni-blocked] ambiguous task match: multiple active tasks (${ids}) match declared paths`,
                };
            }
        } else {
            const ids = candidates.map((t) => t.task_id || t.taskId || t.id).join(', ');
            return {
                task: null,
                error: `[omni-blocked] ambiguous task match: multiple active tasks (${ids}) match declared paths`,
            };
        }
    }

    const matchedTask = candidates[0];
    const normalizedTask = {
        ...matchedTask,
        id: matchedTask.id || matchedTask.task_id || matchedTask.taskId,
        task_id: matchedTask.task_id || matchedTask.taskId || matchedTask.id,
        taskId: matchedTask.taskId || matchedTask.task_id || matchedTask.id,
    };

    return {
        task: normalizedTask,
        error: null,
    };
}

function boundString(str, maxLen = MAX_STRING_FIELD_LEN) {
    if (typeof str !== 'string') return '';
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function sanitizeOutput(output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        return {};
    }

    const clean = {};

    if (typeof output.systemMessage === 'string') {
        clean.systemMessage = boundString(output.systemMessage);
    }

    if (typeof output.decision === 'string') {
        clean.decision = output.decision === 'block' ? 'block' : boundString(output.decision);
    }

    if (typeof output.reason === 'string') {
        clean.reason = boundString(output.reason);
    }

    if (output.hookSpecificOutput && typeof output.hookSpecificOutput === 'object' && !Array.isArray(output.hookSpecificOutput)) {
        const hookOut = {};
        const hso = output.hookSpecificOutput;
        if (typeof hso.hookEventName === 'string') {
            hookOut.hookEventName = boundString(hso.hookEventName, 50);
        }
        if (typeof hso.permissionDecision === 'string') {
            hookOut.permissionDecision = boundString(hso.permissionDecision, 50);
        }
        if (typeof hso.permissionDecisionReason === 'string') {
            hookOut.permissionDecisionReason = boundString(hso.permissionDecisionReason);
        }
        if (typeof hso.additionalContext === 'string') {
            hookOut.additionalContext = boundString(hso.additionalContext);
        }
        clean.hookSpecificOutput = hookOut;
    }

    return clean;
}

function serializeBoundedOutput(output) {
    const clean = sanitizeOutput(output);
    let json = JSON.stringify(clean);
    if (Buffer.byteLength(json, 'utf8') > MAX_STDOUT_BYTES) {
        const fallback = {
            systemMessage: '[omni-blocked] hook output exceeded limit',
        };
        json = JSON.stringify(fallback);
    }
    return json;
}

function findNearestWorkspaceRoot(cwd, fsImpl = fs) {
    if (!cwd || typeof cwd !== 'string') return null;

    let dir;
    try {
        dir = fsImpl.realpathSync?.native ? fsImpl.realpathSync.native(cwd) : (fsImpl.realpathSync ? fsImpl.realpathSync(cwd) : path.resolve(cwd));
    } catch {
        dir = path.resolve(cwd);
    }

    let depth = 0;
    while (depth < 50) {
        const discoveryFile = path.join(dir, '.omni', 'runtime', 'dual', 'daemon.json');
        const manifestFile = path.join(dir, '.omni', 'manifest.json');
        const authorityEvents = path.join(dir, '.omni', 'runs', 'dual-authority', 'events.ndjson');
        if (
            fsImpl.existsSync(discoveryFile) ||
            fsImpl.existsSync(manifestFile) ||
            fsImpl.existsSync(authorityEvents)
        ) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
        depth++;
    }

    return null;
}

function hasDurableAuthority(workspaceRoot, fsImpl = fs) {
    const eventsPath = path.join(workspaceRoot, '.omni', 'runs', 'dual-authority', 'events.ndjson');
    try {
        if (!fsImpl.existsSync(eventsPath)) return false;
        const stat = fsImpl.statSync(eventsPath);
        return stat.isFile() && stat.size > 0;
    } catch {
        return true;
    }
}

function deriveOwnerAndAction(status, health) {
    const state = (status && status.state) ? status.state : (health && health.session_state ? health.session_state : 'UNKNOWN');
    let currentOwner = 'none';
    let nextAction = 'plan registration';

    if (status && status.leases) {
        for (const lease of Object.values(status.leases)) {
            if (lease && lease.status === 'active') {
                currentOwner = lease.owner || 'codex';
                break;
            }
        }
    }

    if (state === 'DISCOVERED' || state === 'CAPABILITY_SAFE') {
        nextAction = 'plan registration';
    } else if (state === 'INTERVIEWING') {
        nextAction = 'interview / plan registration';
    } else if (state === 'PLANNED') {
        nextAction = 'task routing';
    } else if (state === 'EXECUTING') {
        nextAction = currentOwner !== 'none' ? `execute tasks (${currentOwner})` : 'task execution';
    } else if (state === 'ACCEPTANCE') {
        nextAction = 'acceptance verification';
    } else if (state === 'VERIFIED') {
        nextAction = 'session complete';
    } else if (state === 'BLOCKED') {
        nextAction = 'user intervention required';
    }

    return { state, currentOwner, nextAction };
}

async function evaluateHook(rawInput, deps = {}) {
    const {
        fsImpl = fs,
        createClient = createDaemonClient,
        timeoutMs = 500,
        platform = process.platform,
    } = deps;

    let input;
    try {
        input = validateHookInput(rawInput);
    } catch (err) {
        if (rawInput && typeof rawInput === 'object' && rawInput.hook_event_name === 'PreToolUse') {
            return sanitizeOutput({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: `[omni-blocked] invalid hook input: ${err.message}`,
                },
            });
        }
        return sanitizeOutput({
            systemMessage: `[omni-blocked] invalid hook input: ${err.message}`,
        });
    }

    const nearestRoot = findNearestWorkspaceRoot(input.cwd, fsImpl);
    const workspaceRoot = nearestRoot || path.resolve(input.cwd);
    const durableAuthority = hasDurableAuthority(workspaceRoot, fsImpl);
    const preAuthorityPhase = !durableAuthority
        ? evaluatePreAuthorityPhase(input, workspaceRoot, fsImpl)
        : null;

    let client = null;
    try {
        client = createClient({
            workspaceRoot,
            timeoutMs,
            fsImpl,
        });
    } catch {
        client = null;
    }

    let health = null;
    if (client) {
        try {
            health = await client.health();
        } catch {
            health = null;
        }
    }

    // Bootstrap daemon on session start or retry on the first submitted prompt.
    if (
        (!health || health.status !== 'healthy') &&
        (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'UserPromptSubmit')
    ) {
        const spawnImpl = deps.spawn || deps.spawnImpl || spawn;
        try {
            const daemonEntrypoint = path.resolve(__dirname, '..', '..', 'bin', 'omni-daemon.js');
            spawnDaemonProcess({
                workspaceRoot,
                daemonEntrypoint,
                spawnImpl,
                platform,
            });
            if (client && typeof client.waitForHealthy === 'function') {
                const waitTimeout = deps.bootstrapTimeoutMs !== undefined ? deps.bootstrapTimeoutMs : 10000;
                health = await client.waitForHealthy({ timeoutMs: waitTimeout, intervalMs: 50 });
            }
        } catch {
            health = null;
        }
    }

    // Handle daemon loss / unavailable
    if (!health || health.status !== 'healthy') {
        if (!durableAuthority) {
            if (preAuthorityPhase !== null) {
                return preAuthorityPhase;
            }
            if (
                input.hook_event_name === 'PreToolUse' ||
                input.hook_event_name === 'PostToolUse' ||
                input.hook_event_name === 'Stop'
            ) {
                return {};
            }
        }

        if (input.hook_event_name === 'PreToolUse') {
            const classification = classifyTool(input.tool_name, input.tool_input, { workspaceRoot });
            if (classification.classification === 'read') {
                return {};
            }
            return sanitizeOutput({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: '[omni-blocked] Dual daemon is not running or unreachable',
                },
            });
        }

        if (input.hook_event_name === 'PostToolUse') {
            const classification = classifyTool(input.tool_name, input.tool_input, { workspaceRoot });
            if (classification.classification === 'read') {
                return {};
            }
            return sanitizeOutput({
                decision: 'block',
                reason: '[omni-blocked] tool execution observed while Dual daemon is unavailable (action already executed)',
                hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    additionalContext: '[omni] Tool executed while daemon unavailable. Final fingerprint gate will reject unverifiable changes.',
                },
            });
        }

        if (input.hook_event_name === 'SessionStart') {
            return sanitizeOutput({
                systemMessage: '[omni] Dual daemon is not running. AUTO authority disabled.',
            });
        }

        if (input.hook_event_name === 'UserPromptSubmit') {
            return {};
        }

        if (input.hook_event_name === 'Stop') {
            return sanitizeOutput({
                systemMessage: '[omni-blocked] Dual daemon is not running or unavailable. Stopping turn.',
            });
        }

        return {};
    }

    const omniSessionId = health.session_id;

    if (
        !omniSessionId &&
        !durableAuthority &&
        (
            input.hook_event_name === 'PreToolUse' ||
            input.hook_event_name === 'PostToolUse' ||
            input.hook_event_name === 'Stop'
        )
    ) {
        return preAuthorityPhase !== null ? preAuthorityPhase : {};
    }

    // Dispatch by hook event name
    switch (input.hook_event_name) {
        case 'SessionStart': {
            if (omniSessionId) {
                let status;
                try {
                    status = await client.status(omniSessionId);
                } catch {
                    status = null;
                }
                const { state, currentOwner, nextAction } = deriveOwnerAndAction(status, health);
                const revision = (status && status.plan_revision) ? status.plan_revision : 1;
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'SessionStart',
                        additionalContext: `[omni] Dual AUTO session active: session_id=${omniSessionId}, state=${state}, plan_revision=${revision}, owner=${currentOwner}, next_action=${nextAction}`,
                    },
                });
            }
            return sanitizeOutput({
                hookSpecificOutput: {
                    hookEventName: 'SessionStart',
                    additionalContext: '[omni] Dual daemon running. No active Dual session initialized.',
                },
            });
        }

        case 'UserPromptSubmit': {
            if (omniSessionId) {
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'UserPromptSubmit',
                        additionalContext: `[omni] Dual authority active: session_id=${omniSessionId}, state=${health.session_state || 'active'}`,
                    },
                });
            }
            return sanitizeOutput({
                hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit',
                    additionalContext: '[omni] Dual daemon running. No active Dual session initialized.',
                },
            });
        }

        case 'PreToolUse': {
            const classification = classifyTool(input.tool_name, input.tool_input, { workspaceRoot });

            if (classification.classification === 'denied') {
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: classification.reason || '[omni-blocked] tool denied fail-closed',
                    },
                });
            }

            if (classification.classification === 'read') {
                if (!omniSessionId) {
                    return {};
                }
                try {
                    const evalRes = await client.evaluateHook(omniSessionId, {
                        hook_event_name: 'PreToolUse',
                        operation: 'read',
                    });
                    if (evalRes.permissionDecision === 'allow' || evalRes.decision === 'allow') {
                        return {};
                    }
                    return sanitizeOutput({
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: evalRes.permissionDecisionReason || evalRes.reason || '[omni-blocked] read operation denied',
                        },
                    });
                } catch (err) {
                    return sanitizeOutput({
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: `[omni-blocked] daemon read evaluation failed: ${err.message}`,
                        },
                    });
                }
            }

            // Write / Execute mutation
            if (!omniSessionId) {
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: '[omni-blocked] no active Dual session for mutating tool',
                    },
                });
            }

            let status;
            try {
                status = await client.status(omniSessionId);
            } catch (err) {
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: `[omni-blocked] failed to query session status: ${err.message}`,
                    },
                });
            }

            if (status.state === 'BLOCKED') {
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: '[omni-blocked] session is BLOCKED',
                    },
                });
            }

            if (classification.phaseOperation === 'planning') {
                return {};
            }

            const match = inferTask(status.tasks, status.leases, classification.paths);
            if (match.error || !match.task) {
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: match.error || '[omni-blocked] no matching task found',
                    },
                });
            }

            try {
                const evalRes = await client.evaluateHook(omniSessionId, {
                    hook_event_name: 'PreToolUse',
                    operation: classification.paths.length > 1 ? 'execute' : 'write',
                    task_id: match.task.id,
                    owner: 'codex',
                    file_path: classification.paths[0],
                    declared_paths: classification.paths,
                });

                if (evalRes.permissionDecision === 'allow' || evalRes.decision === 'allow') {
                    return {};
                }

                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: evalRes.permissionDecisionReason || evalRes.reason || '[omni-blocked] mutation denied by daemon',
                    },
                });
            } catch (err) {
                return sanitizeOutput({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: `[omni-blocked] daemon evaluation error: ${err.message}`,
                    },
                });
            }
        }

        case 'PostToolUse': {
            const classification = classifyTool(input.tool_name, input.tool_input, { workspaceRoot });
            if (classification.classification === 'read') {
                return {};
            }

            if (classification.classification === 'denied') {
                return sanitizeOutput({
                    decision: 'block',
                    reason: '[omni-blocked] unverified or denied tool execution detected (action already executed)',
                    hookSpecificOutput: {
                        hookEventName: 'PostToolUse',
                        additionalContext: '[omni] Unverified or denied tool executed. Final fingerprint gate will reject unverifiable changes.',
                    },
                });
            }

            if (classification.classification === 'write' || classification.classification === 'execute') {
                if (!omniSessionId) {
                    return sanitizeOutput({
                        decision: 'block',
                        reason: '[omni-blocked] mutation observed without active Dual session (action already executed)',
                        hookSpecificOutput: {
                            hookEventName: 'PostToolUse',
                            additionalContext: '[omni] Mutation observed outside active Dual session. Final fingerprint gate will reject unverifiable changes.',
                        },
                    });
                }

                let status;
                try {
                    status = await client.status(omniSessionId);
                } catch {
                    status = null;
                }

                if (!status) {
                    return sanitizeOutput({
                        decision: 'block',
                        reason: '[omni-blocked] failed to verify session status post-tool (action already executed)',
                        hookSpecificOutput: {
                            hookEventName: 'PostToolUse',
                            additionalContext: '[omni] Session status verification failed. Final fingerprint gate will reject unverifiable changes.',
                        },
                    });
                }

                if (status.state === 'BLOCKED') {
                    return sanitizeOutput({
                        decision: 'block',
                        reason: '[omni-blocked] mutation observed on BLOCKED session (action already executed)',
                        hookSpecificOutput: {
                            hookEventName: 'PostToolUse',
                            additionalContext: '[omni] Mutation observed while session is BLOCKED. Final fingerprint gate will reject unverifiable changes.',
                        },
                    });
                }

                if (classification.phaseOperation === 'planning') {
                    return {};
                }

                const match = inferTask(status.tasks, status.leases, classification.paths);
                if (match.error || !match.task || match.task.owner !== 'codex') {
                    const violationMsg = match.error ? 'task matching failed' : (match.task ? `task ${match.task.id} is ${match.task.owner === 'agy' ? 'AGY_OWNED' : match.task.owner}` : 'unauthorized path');
                    return sanitizeOutput({
                        decision: 'block',
                        reason: `[omni-blocked] scope or owner violation detected post-tool (action already executed)`,
                        hookSpecificOutput: {
                            hookEventName: 'PostToolUse',
                            additionalContext: `[omni] Scope/owner violation detected post-tool execution: ${violationMsg}. Final fingerprint gate will reject unverifiable changes.`,
                        },
                    });
                }

                return {};
            }

            return {};
        }

        case 'Stop': {
            if (!omniSessionId) {
                return sanitizeOutput({
                    systemMessage: '[omni-blocked] No active Dual session. Stopping turn.',
                });
            }

            let status;
            try {
                status = await client.status(omniSessionId);
            } catch {
                status = null;
            }

            if (status && status.state === 'BLOCKED') {
                const blockReason = (status.blocked && status.blocked.reason) ? status.blocked.reason : 'user intervention required';
                return sanitizeOutput({
                    systemMessage: `[omni-blocked] Dual session is BLOCKED: ${blockReason}. Turn completed.`,
                });
            }

            let completion;
            try {
                completion = await client.evaluateCompletion(omniSessionId);
            } catch (err) {
                return sanitizeOutput({
                    systemMessage: `[omni-blocked] Failed to evaluate completion: ${err.message}. Stopping turn.`,
                });
            }

            if (completion && completion.verified === true) {
                return {};
            }

            const blockerDetails = (completion && completion.blockers && completion.blockers.length > 0)
                ? completion.blockers.join('; ')
                : 'tasks or acceptance gates incomplete';

            if (input.stop_hook_active === true) {
                return sanitizeOutput({
                    systemMessage: `[omni-blocked] Dual AUTO session still incomplete after continuation: ${blockerDetails}. Stopping loop for user inspection.`,
                });
            }

            return sanitizeOutput({
                decision: 'block',
                reason: `[omni] Dual AUTO session incomplete: ${blockerDetails}. Continue execution to complete pending tasks/gates.`,
            });
        }

        default:
            return {};
    }
}

module.exports = {
    DualHookBridgeError,
    ALLOWED_EVENT_NAMES,
    validateHookInput,
    cleanAndValidateRepoPath,
    extractPatchPaths,
    extractMcpPaths,
    extractEventHint,
    classifyTool,
    inferTask,
    sanitizeOutput,
    serializeBoundedOutput,
    findNearestWorkspaceRoot,
    hasDurableAuthority,
    isDesignReady,
    isPreAuthorityPlanningPath,
    quoteWindowsCommandLineArg,
    spawnDaemonProcess,
    evaluateHook,
};
