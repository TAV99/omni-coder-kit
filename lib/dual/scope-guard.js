'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { execGit, normalizeRepoPath } = require('./workspace');

class DualScopeError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualScopeError';
        this.code = code;
        this.details = details;
    }
}

function compileDenyGlob(pattern) {
    let source = '^';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '*') {
            if (pattern[index + 1] === '*') {
                index += 1;
                if (pattern[index + 1] === '/') {
                    index += 1;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
            }
        } else if (character === '?') {
            source += '[^/]';
        } else {
            source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    return new RegExp(`${source}$`);
}

function matchesDenyPattern(repoPath, pattern) {
    const normalizedPath = String(repoPath).replace(/\\/g, '/');
    const normalizedPattern = String(pattern).replace(/\\/g, '/');
    return compileDenyGlob(normalizedPattern).test(normalizedPath);
}

function readNulPaths(buffer) {
    return buffer.toString('utf8').split('\0').filter(Boolean).map((file) => file.replace(/\\/g, '/'));
}

function captureDiffFingerprint({ repoRoot, baseCommit, excludedPaths = [], execGit: git = execGit }) {
    const allExcluded = ['.omni', ...excludedPaths];
    const excluded = allExcluded.map((item) => String(item).replace(/\\/g, '/').replace(/\/+$/, ''));
    const isExcluded = (file) => excluded.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
    const pathspecs = ['.'];
    for (const prefix of excluded) {
        pathspecs.push(`:(exclude)${prefix}`, `:(exclude)${prefix}/**`);
    }
    const trackedPatch = git(
        ['diff', '--binary', baseCommit, '--', ...pathspecs],
        { cwd: repoRoot, encoding: null },
    );
    const trackedNames = readNulPaths(git(
        ['diff', '--name-only', '-z', baseCommit, '--', ...pathspecs],
        { cwd: repoRoot, encoding: null }
    )).filter((file) => !isExcluded(file));
    const untrackedNames = readNulPaths(git(
        ['ls-files', '--others', '--exclude-standard', '-z'],
        { cwd: repoRoot, encoding: null }
    )).filter((file) => !isExcluded(file));
    const files = [...new Set([...trackedNames, ...untrackedNames])].sort();

    const hash = crypto.createHash('sha256');
    hash.update(String(baseCommit));
    hash.update('\0');
    hash.update(Buffer.isBuffer(trackedPatch) ? trackedPatch : Buffer.from(String(trackedPatch)));
    for (const file of untrackedNames.sort()) {
        const normalized = normalizeRepoPath(repoRoot, file);
        hash.update('\0');
        hash.update(normalized);
        hash.update('\0');
        hash.update(fs.readFileSync(path.join(repoRoot, ...normalized.split('/'))));
    }
    return { files, patchSha256: hash.digest('hex') };
}

function assertAllowedDiff({ changedFiles, allowedFiles, denyPatterns = [] }) {
    const allowed = new Set(allowedFiles.map((file) => String(file).replace(/\\/g, '/')));
    const normalizedChanges = changedFiles.map((file) => String(file).replace(/\\/g, '/'));
    const denied = normalizedChanges.filter((file) => denyPatterns.some((pattern) => matchesDenyPattern(file, pattern)));
    if (denied.length > 0) {
        throw new DualScopeError(
            'DUAL_DENY_PATTERN',
            `Worker changed denied paths: ${denied.join(', ')}`,
            { denied }
        );
    }
    const outside = normalizedChanges.filter((file) => !allowed.has(file));
    if (outside.length > 0) {
        throw new DualScopeError(
            'DUAL_SCOPE_VIOLATION',
            `Worker changed files outside allowed scope: ${outside.join(', ')}`,
            { outside }
        );
    }
    return { changedFiles: normalizedChanges };
}

function assertReviewUnchanged(before, after) {
    const sameFiles = JSON.stringify(before.files) === JSON.stringify(after.files);
    if (!sameFiles || before.patchSha256 !== after.patchSha256) {
        throw new DualScopeError(
            'DUAL_REVIEW_MUTATION',
            'Review phase changed the post-implementation diff.',
            { before, after }
        );
    }
    return after;
}

module.exports = {
    DualScopeError,
    matchesDenyPattern,
    captureDiffFingerprint,
    assertAllowedDiff,
    assertReviewUnchanged,
};
