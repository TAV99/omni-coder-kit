'use strict';

const RUNTIME_ENV_KEYS = Object.freeze([
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'PATHEXT',
    'COMSPEC',
]);

const SECRET_TOKEN_SOURCE = '(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret(?:[_-]?access[_-]?key)?)';
const SECRET_NAME_SOURCE = `(?:[A-Za-z0-9_-]*${SECRET_TOKEN_SOURCE}[A-Za-z0-9_-]*|authorization)`;
const SECRET_NAME_PATTERN = new RegExp(SECRET_NAME_SOURCE, 'i');

function buildValidatorEnv(sourceEnv = process.env, overrides = {}) {
    const output = {};
    for (const key of RUNTIME_ENV_KEYS) {
        if (typeof sourceEnv?.[key] === 'string') output[key] = sourceEnv[key];
    }
    for (const [key, value] of Object.entries(overrides || {})) {
        if (typeof value !== 'string' || SECRET_NAME_PATTERN.test(key)) continue;
        output[key] = value;
    }
    return output;
}

function stringifyDiagnostic(value) {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return value == null ? '' : String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function normalizeEscapedSecretKeys(value) {
    return value.replace(/"((?:\\.|[^"\\\r\n])*)"(\s*):/g, (match, encodedName, spacing) => {
        let name;
        try {
            name = JSON.parse(`"${encodedName}"`);
        } catch {
            return match;
        }
        if (typeof name !== 'string' || !SECRET_NAME_PATTERN.test(name)) return match;
        return `"${name}"${spacing}:`;
    });
}

function redactDiagnostic(value, limits = {}) {
    const requestedLimit = Number.isSafeInteger(limits.maxLength) ? limits.maxLength : 16384;
    const maxLength = Math.max(0, Math.min(requestedLimit, 1024 * 1024));
    const keyedValuePattern = new RegExp(
        `((?:"${SECRET_NAME_SOURCE}"|${SECRET_NAME_SOURCE})\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\\\r\\n])*"|'(?:\\\\.|[^'\\\\\\r\\n])*'|[^,;&\\r\\n]+)`,
        'gi'
    );
    const splitArgPattern = new RegExp(`(--?${SECRET_NAME_SOURCE}\\s+)(?:"(?:\\\\.|[^"\\\\\\r\\n])*"|'(?:\\\\.|[^'\\\\\\r\\n])*'|[^,;\\r\\n]+)`, 'gi');
    const inlineArgPattern = new RegExp(`(--?${SECRET_NAME_SOURCE}=)(?:"(?:\\\\.|[^"\\\\\\r\\n])*"|'(?:\\\\.|[^'\\\\\\r\\n])*'|[^,;\\r\\n]+)`, 'gi');

    return normalizeEscapedSecretKeys(stringifyDiagnostic(value))
        .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
        .replace(/([?&][^=\s&#]+)=([^&#\s]*)/g, '$1=[REDACTED]')
        .replace(/(\bauthorization\s*[:=]\s*)(?:(?:basic|bearer)\s+)?(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^,;\r\n]+)/gi, '$1[REDACTED]')
        .replace(/\bbearer\s+(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^,;\r\n]+)/gi, 'Bearer [REDACTED]')
        .replace(splitArgPattern, '$1[REDACTED]')
        .replace(inlineArgPattern, '$1[REDACTED]')
        .replace(keyedValuePattern, '$1[REDACTED]')
        .slice(0, maxLength);
}

function redactArgv(args) {
    const redacted = [];
    let redactNext = false;
    for (const rawArg of args || []) {
        const arg = String(rawArg);
        if (redactNext) {
            redacted.push('[REDACTED]');
            redactNext = false;
            continue;
        }
        const option = arg.match(/^--?([A-Za-z0-9_-]+)$/);
        if (option && SECRET_NAME_PATTERN.test(option[1])) {
            redacted.push(arg);
            redactNext = true;
            continue;
        }
        const inlineSecret = arg.match(/^(--?[A-Za-z0-9_-]+=)([\s\S]*)$/);
        if (inlineSecret && SECRET_NAME_PATTERN.test(inlineSecret[1].slice(2, -1))) {
            redacted.push(`${inlineSecret[1]}[REDACTED]`);
            continue;
        }
        redacted.push(redactDiagnostic(arg));
    }
    return redacted;
}

module.exports = {
    RUNTIME_ENV_KEYS,
    buildValidatorEnv,
    redactArgv,
    redactDiagnostic,
};
