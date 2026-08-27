'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class DualArtifactError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DualArtifactError';
        this.code = code;
    }
}

function isInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRelativePath(relativePath) {
    if (
        typeof relativePath !== 'string'
        || relativePath.length === 0
        || relativePath.includes('\0')
        || path.isAbsolute(relativePath)
        || path.win32.isAbsolute(relativePath)
        || path.posix.isAbsolute(relativePath)
    ) {
        throw new DualArtifactError('DUAL_ARTIFACT_PATH', 'Artifact path must be a safe relative path');
    }

    const normalized = path.normalize(relativePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new DualArtifactError('DUAL_ARTIFACT_PATH', 'Artifact path escapes the run directory');
    }
    return normalized;
}

function createArtifactStore(runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    const canonicalRunDir = fs.realpathSync.native(runDir);

    function resolveTarget(relativePath) {
        const normalized = validateRelativePath(relativePath);
        const target = path.resolve(canonicalRunDir, normalized);
        if (!isInside(canonicalRunDir, target) || target === canonicalRunDir) {
            throw new DualArtifactError('DUAL_ARTIFACT_PATH', 'Artifact path escapes the run directory');
        }

        const parent = path.dirname(target);
        fs.mkdirSync(parent, { recursive: true });
        const canonicalParent = fs.realpathSync.native(parent);
        if (!isInside(canonicalRunDir, canonicalParent)) {
            throw new DualArtifactError('DUAL_ARTIFACT_PATH', 'Artifact parent escapes the run directory');
        }
        return path.join(canonicalParent, path.basename(target));
    }

    function sha256(content) {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    function writeImmutable(relativePath, content) {
        const target = resolveTarget(relativePath);
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        try {
            fs.writeFileSync(target, bytes, { flag: 'wx' });
        } catch (error) {
            if (error && error.code === 'EEXIST') {
                throw new DualArtifactError('DUAL_ARTIFACT_EXISTS', 'Immutable artifact already exists');
            }
            throw error;
        }
        return { path: target, sha256: sha256(bytes) };
    }

    function writeJsonImmutable(relativePath, value) {
        return writeImmutable(relativePath, `${JSON.stringify(value, null, 2)}\n`);
    }

    function writeJsonAtomic(relativePath, value) {
        const target = resolveTarget(relativePath);
        const content = `${JSON.stringify(value, null, 2)}\n`;
        const temporary = path.join(
            path.dirname(target),
            `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
        );
        try {
            fs.writeFileSync(temporary, content, { flag: 'wx' });
            fs.renameSync(temporary, target);
        } finally {
            if (fs.existsSync(temporary)) {
                fs.unlinkSync(temporary);
            }
        }
        return { path: target, sha256: sha256(content) };
    }

    return {
        writeImmutable,
        writeJsonImmutable,
        writeJsonAtomic,
        sha256,
    };
}

module.exports = {
    DualArtifactError,
    createArtifactStore,
};
