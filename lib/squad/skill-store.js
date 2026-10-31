'use strict';

// Canonical skill store (SPEC-SQUAD-P2 §6.1): .omni/skills/<name>/SKILL.md is
// the only place skill content lives; roles get copies mounted from here.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SKILL_NAME } = require('./skills-catalog');

const STORE_DIR = path.join('.omni', 'skills');
const MOUNT_MARKER = '.omni-squad-mount.json';
const MAX_SKILL_BYTES = 8 * 1024 * 1024;

class SquadSkillError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SquadSkillError';
        this.code = code;
    }
}

// Sorted [relativePosixPath, absolutePath] of a skill dir, skipping the mount marker.
function skillFiles(dir, fsImpl = fs) {
    const files = [];
    let total = 0;
    const visit = (relative) => {
        const absolute = relative ? path.join(dir, ...relative.split('/')) : dir;
        for (const entry of fsImpl.readdirSync(absolute, { withFileTypes: true })) {
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            if (!relative && entry.name === MOUNT_MARKER) continue;
            if (entry.isSymbolicLink()) throw new SquadSkillError('SQUAD_SKILL_INVALID', `${dir}: skills cannot contain symlinks (${rel})`);
            if (entry.isDirectory()) visit(rel);
            else if (entry.isFile()) {
                const full = path.join(dir, ...rel.split('/'));
                total += fsImpl.statSync(full).size;
                if (total > MAX_SKILL_BYTES) throw new SquadSkillError('SQUAD_SKILL_INVALID', `${dir}: larger than ${MAX_SKILL_BYTES} bytes`);
                files.push([rel, full]);
            }
        }
    };
    visit('');
    return files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function hashDir(dir, fsImpl = fs) {
    const outer = crypto.createHash('sha256');
    for (const [rel, full] of skillFiles(dir, fsImpl)) {
        const inner = crypto.createHash('sha256').update(fsImpl.readFileSync(full)).digest('hex');
        outer.update(`${rel}\0${inner}\n`);
    }
    return outer.digest('hex');
}

function isSkillDir(dir, fsImpl = fs) {
    try {
        return fsImpl.lstatSync(dir).isDirectory() && fsImpl.statSync(path.join(dir, 'SKILL.md')).isFile();
    } catch {
        return false;
    }
}

function readMarker(dir, fsImpl = fs) {
    try {
        const value = JSON.parse(fsImpl.readFileSync(path.join(dir, MOUNT_MARKER), 'utf8'));
        return value && value.schema_version === 1 && typeof value.role === 'string' && typeof value.skill === 'string' ? value : null;
    } catch {
        return null;
    }
}

function copyDir(from, to, fsImpl = fs) {
    fsImpl.mkdirSync(to, { recursive: true });
    for (const [rel, full] of skillFiles(from, fsImpl)) {
        const target = path.join(to, ...rel.split('/'));
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        fsImpl.copyFileSync(full, target);
    }
}

function createSkillStore(projectRoot, { fsImpl = fs } = {}) {
    const dir = path.join(projectRoot, STORE_DIR);
    const pathOf = (name) => {
        if (!SKILL_NAME.test(name)) throw new SquadSkillError('SQUAD_SKILL_INVALID', `invalid skill name "${name}"`);
        return path.join(dir, name);
    };
    const has = (name) => SKILL_NAME.test(name) && isSkillDir(pathOf(name), fsImpl);

    return {
        dir,
        pathOf,
        has,
        list() {
            if (!fsImpl.existsSync(dir)) return [];
            return fsImpl.readdirSync(dir).filter((name) => SKILL_NAME.test(name) && has(name)).sort();
        },
        hashOf(name) {
            if (!has(name)) throw new SquadSkillError('SQUAD_SKILL_MISSING', `skill "${name}" is not in ${STORE_DIR}`);
            return hashDir(pathOf(name), fsImpl);
        },
        // Copies unmanaged skill dirs (no mount marker) from sourceDir into the store.
        importFrom(sourceDir) {
            const result = { imported: [], same: [], conflicts: [] };
            if (!fsImpl.existsSync(sourceDir)) return result;
            for (const name of fsImpl.readdirSync(sourceDir).sort()) {
                const from = path.join(sourceDir, name);
                if (!SKILL_NAME.test(name) || !isSkillDir(from, fsImpl) || readMarker(from, fsImpl)) continue;
                if (!has(name)) {
                    copyDir(from, pathOf(name), fsImpl);
                    result.imported.push(name);
                } else if (hashDir(from, fsImpl) === hashDir(pathOf(name), fsImpl)) {
                    result.same.push(name);
                } else {
                    result.conflicts.push(name);
                }
            }
            return result;
        },
    };
}

module.exports = {
    STORE_DIR, MOUNT_MARKER, SquadSkillError,
    createSkillStore, hashDir, isSkillDir, readMarker, copyDir,
};
