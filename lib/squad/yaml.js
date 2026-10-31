'use strict';

// Safe YAML for squad config files (SPEC-SQUAD-P2 §3, D17): plain data only.
// Aliases, custom/known extra tags and merge keys are rejected, and warnings
// count as errors so an unknown tag never degrades into a silent string.

const fs = require('node:fs');
const YAML = require('yaml');

const MAX_CONFIG_BYTES = 64 * 1024;

class SquadConfigError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SquadConfigError';
        this.code = 'SQUAD_CONFIG_INVALID';
        this.details = details;
    }
}

const PARSE_OPTIONS = Object.freeze({
    schema: 'core',
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    merge: false,
    resolveKnownTags: false,
    prettyErrors: true,
});

function position(problem) {
    const at = Array.isArray(problem.linePos) ? problem.linePos[0] : null;
    return at ? { line: at.line, col: at.col } : {};
}

function parseYamlText(text, { source = '<yaml>' } = {}) {
    if (typeof text !== 'string') throw new SquadConfigError(`${source}: content must be text`, { source });
    const doc = YAML.parseDocument(text, PARSE_OPTIONS);
    const problems = [...doc.errors, ...doc.warnings];
    if (problems.length > 0) {
        const first = problems[0];
        const { line, col } = position(first);
        const where = line ? `:${line}:${col}` : '';
        throw new SquadConfigError(`${source}${where}: ${String(first.message).split('\n')[0]}`, {
            source, line, col, issues: problems.map((p) => ({ message: String(p.message).split('\n')[0], ...position(p) })),
        });
    }
    let value;
    try {
        value = doc.toJS({ maxAliasCount: 0 });
    } catch (error) {
        throw new SquadConfigError(`${source}: ${error.message}`, { source });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SquadConfigError(`${source}: top level must be a mapping`, { source });
    }
    return value;
}

function parseYamlFile(filePath, { maxBytes = MAX_CONFIG_BYTES, fsImpl = fs } = {}) {
    let stat;
    try {
        stat = fsImpl.lstatSync(filePath);
    } catch (error) {
        throw new SquadConfigError(`${filePath}: cannot read (${error.code || error.message})`, { source: filePath });
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new SquadConfigError(`${filePath}: must be a regular file, not a symlink`, { source: filePath });
    }
    if (stat.size > maxBytes) {
        throw new SquadConfigError(`${filePath}: larger than ${maxBytes} bytes`, { source: filePath });
    }
    return parseYamlText(fsImpl.readFileSync(filePath, 'utf8'), { source: filePath });
}

// zod issues → one readable SquadConfigError
function schemaError(source, issues) {
    const lines = issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return new SquadConfigError(`${source}: ${lines.join('; ')}`, { source, issues: lines });
}

module.exports = { SquadConfigError, MAX_CONFIG_BYTES, parseYamlText, parseYamlFile, schemaError };
