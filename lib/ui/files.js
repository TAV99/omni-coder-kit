'use strict';

// `child` is `root` or inside it; a bare prefix check would admit `/proj-evil` for `/proj`.
const isInside = (root, child) => { const rel = require('node:path').relative(root, child); const { sep, isAbsolute } = require('node:path'); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

// Bounded project file service for Omni UI (T07)
// Enforces strict sandbox boundaries, path traversal defense,
// denied credential protection, and format-specific size limits.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;    // 2 MiB
const MAX_PDF_BYTES = 25 * 1024 * 1024;   // 25 MiB
const MAX_DOCX_BYTES = 10 * 1024 * 1024;  // 10 MiB
const MAX_DIR_ENTRIES = 500;

const DENY_PATTERNS = [
    /^\.env(\..+)?$/i,
    /^\.git(\/|\\|$)/i,
    /id_rsa/i,
    /id_ed25519/i,
    /\.pem$/i,
    /\.key$/i,
    /^\.omni\/runs(\/|\\|$)/i,
];

function isDenied(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/');
    const base = path.basename(normalized);
    for (const pat of DENY_PATTERNS) {
        if (pat.test(normalized) || pat.test(base)) {
            return true;
        }
    }
    return false;
}

function inferType(filename) {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.md':
            return { type: 'markdown', limit: MAX_TEXT_BYTES };
        case '.pdf':
            return { type: 'pdf', limit: MAX_PDF_BYTES };
        case '.docx':
            return { type: 'docx', limit: MAX_DOCX_BYTES };
        case '.html':
        case '.htm':
            return { type: 'html', limit: MAX_TEXT_BYTES };
        case '.txt':
        case '.json':
        case '.js':
        case '.mjs':
        case '.cjs':
        case '.css':
        case '.yaml':
        case '.yml':
            return { type: 'text', limit: MAX_TEXT_BYTES };
        default:
            return { type: 'text', limit: MAX_TEXT_BYTES };
    }
}

function createFileService({
    projectRoot,
    fsImpl = fs,
}) {
    const realRoot = fsImpl.realpathSync.native(projectRoot);
    const handles = new Map(); // handle -> { realPath, relativePath, revision, type, size }

    function resolveSafePath(userPath) {
        if (typeof userPath !== 'string' || !userPath.trim()) {
            const err = new Error('Invalid empty path');
            err.code = 'INVALID_PATH';
            err.status = 400;
            throw err;
        }

        // Null bytes or encoded traversal check
        if (userPath.includes('\0')) {
            const err = new Error('Null bytes forbidden');
            err.code = 'TRAVERSAL_FORBIDDEN';
            err.status = 400;
            throw err;
        }

        if (/%2e|%2f/i.test(userPath)) {
            const err = new Error('Percent encoded path traversal forbidden');
            err.code = 'TRAVERSAL_FORBIDDEN';
            err.status = 403;
            throw err;
        }

        // Absolute / Drive / UNC paths
        if (path.isAbsolute(userPath) || /^[a-zA-Z]:|[\\/]{2}/.test(userPath)) {
            const err = new Error('Absolute paths forbidden');
            err.code = 'TRAVERSAL_FORBIDDEN';
            err.status = 403;
            throw err;
        }

        const normalized = path.normalize(userPath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            const err = new Error('Path traversal outside project root forbidden');
            err.code = 'TRAVERSAL_FORBIDDEN';
            err.status = 403;
            throw err;
        }

        if (isDenied(normalized)) {
            const err = new Error(`Access to ${normalized} is denied by policy`);
            err.code = 'FILE_ACCESS_DENIED';
            err.status = 403;
            throw err;
        }

        const resolved = path.resolve(realRoot, normalized);
        if (!isInside(realRoot, resolved)) {
            const err = new Error('Resolved path escapes project root');
            err.code = 'TRAVERSAL_FORBIDDEN';
            err.status = 403;
            throw err;
        }

        // Check symlinks
        if (fsImpl.existsSync(resolved)) {
            let realTarget;
            try {
                realTarget = fsImpl.realpathSync.native(resolved);
            } catch {
                realTarget = resolved;
            }
            if (!isInside(realRoot, realTarget)) {
                const err = new Error('Symlink target escapes project root');
                err.code = 'TRAVERSAL_FORBIDDEN';
                err.status = 403;
                throw err;
            }
            return { resolvedPath: realTarget, relativePath: path.relative(realRoot, realTarget) };
        }

        return { resolvedPath: resolved, relativePath: normalized };
    }

    function listDirectory(subpath = '', { cursor = 0, limit = MAX_DIR_ENTRIES } = {}) {
        const { resolvedPath } = resolveSafePath(subpath || '.');
        if (!fsImpl.existsSync(resolvedPath)) {
            const err = new Error(`Directory ${subpath} not found`);
            err.code = 'DIR_NOT_FOUND';
            err.status = 404;
            throw err;
        }

        const stat = fsImpl.statSync(resolvedPath);
        if (!stat.isDirectory()) {
            const err = new Error(`Path ${subpath} is not a directory`);
            err.code = 'NOT_A_DIRECTORY';
            err.status = 400;
            throw err;
        }

        const rawEntries = fsImpl.readdirSync(resolvedPath, { withFileTypes: true });
        const filtered = [];

        for (const dirent of rawEntries) {
            const name = dirent.name;
            if (name === 'node_modules' || name === '.git' || name === '.omni/runs') continue;
            // Ignore hidden dotfiles unless explicit documentation
            if (name.startsWith('.') && name !== '.omni') continue;
            if (isDenied(name)) continue;

            const isDir = dirent.isDirectory();
            const { type } = inferType(name);
            filtered.push({
                name,
                isDirectory: isDir,
                type: isDir ? 'directory' : type,
            });
        }

        filtered.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        const startIdx = Number(cursor) || 0;
        const pageLimit = Math.min(Number(limit) || MAX_DIR_ENTRIES, MAX_DIR_ENTRIES);
        const paged = filtered.slice(startIdx, startIdx + pageLimit);
        const nextCursor = startIdx + paged.length < filtered.length ? startIdx + paged.length : null;

        return {
            entries: paged,
            total: filtered.length,
            nextCursor,
        };
    }

    function open(relativePath) {
        const { resolvedPath, relativePath: safeRelative } = resolveSafePath(relativePath);

        if (!fsImpl.existsSync(resolvedPath)) {
            const err = new Error(`File ${relativePath} not found`);
            err.code = 'FILE_NOT_FOUND';
            err.status = 404;
            throw err;
        }

        const stat = fsImpl.statSync(resolvedPath);
        if (!stat.isFile()) {
            const err = new Error(`Path ${relativePath} is not a regular file`);
            err.code = 'NOT_A_FILE';
            err.status = 400;
            throw err;
        }

        const { type, limit } = inferType(safeRelative);
        if (stat.size > limit) {
            const err = new Error(`File ${relativePath} size (${stat.size} bytes) exceeds limit of ${limit} bytes`);
            err.code = 'FILE_TOO_LARGE';
            err.status = 413;
            throw err;
        }

        const revision = `${Math.floor(stat.mtimeMs)}-${stat.size}`;
        const handle = `file-${crypto.randomUUID()}`;

        const meta = {
            handle,
            relativePath: safeRelative,
            name: path.basename(safeRelative),
            type,
            size: stat.size,
            revision,
            resolvedPath,
        };

        handles.set(handle, meta);

        return {
            handle: meta.handle,
            relativePath: meta.relativePath,
            name: meta.name,
            type: meta.type,
            size: meta.size,
            revision: meta.revision,
        };
    }

    function readContent(handle, expectedRevision) {
        const meta = handles.get(handle);
        if (!meta) {
            const err = new Error(`File handle ${handle} not found or expired`);
            err.code = 'FILE_NOT_FOUND';
            err.status = 404;
            throw err;
        }

        if (!fsImpl.existsSync(meta.resolvedPath)) {
            const err = new Error(`File ${meta.relativePath} has been deleted`);
            err.code = 'FILE_DELETED';
            err.status = 404;
            throw err;
        }

        const stat = fsImpl.statSync(meta.resolvedPath);
        const currentRevision = `${Math.floor(stat.mtimeMs)}-${stat.size}`;

        if (expectedRevision && currentRevision !== expectedRevision) {
            const err = new Error(`File revision conflict. Expected ${expectedRevision}, current ${currentRevision}`);
            err.code = 'FILE_STALE_REVISION';
            err.status = 409;
            throw err;
        }

        return fsImpl.readFileSync(meta.resolvedPath);
    }

    async function handleRoute(req, res, url, { send, readJsonBody }) {
        // GET /api/files?directory=...&cursor=...
        if (req.method === 'GET' && url.pathname === '/api/files') {
            const dir = url.searchParams.get('directory') || '';
            const cursor = url.searchParams.get('cursor') || 0;
            try {
                const listing = listDirectory(dir, { cursor });
                send(res, 200, listing);
            } catch (err) {
                send(res, err.status || 400, { error: err.message, code: err.code || null });
            }
            return true;
        }

        // POST /api/files/open
        if (req.method === 'POST' && url.pathname === '/api/files/open') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
                send(res, 415, { error: 'expected application/json' });
                return true;
            }

            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                send(res, 400, { error: err.message });
                return true;
            }

            try {
                const meta = open(body.relative_path || body.relativePath);
                send(res, 200, meta);
            } catch (err) {
                send(res, err.status || 400, { error: err.message, code: err.code || null });
            }
            return true;
        }

        // GET /api/files/:id/content?revision=...
        const contentMatch = /^\/api\/files\/([^/]+)\/content$/.exec(url.pathname);
        if (req.method === 'GET' && contentMatch) {
            const handleId = contentMatch[1];
            const revision = url.searchParams.get('revision');
            try {
                const buffer = readContent(handleId, revision);
                const meta = handles.get(handleId);
                const contentType = meta?.type === 'pdf' ? 'application/pdf'
                    : meta?.type === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    : meta?.type === 'html' ? 'text/html; charset=utf-8'
                    : 'text/plain; charset=utf-8';
                send(res, 200, buffer, contentType);
            } catch (err) {
                send(res, err.status || 400, { error: err.message, code: err.code || null });
            }
            return true;
        }

        return false;
    }

    return {
        listDirectory,
        open,
        readContent,
        handleRoute,
    };
}

module.exports = {
    createFileService,
    MAX_TEXT_BYTES,
    MAX_PDF_BYTES,
    MAX_DOCX_BYTES,
    MAX_DIR_ENTRIES,
};
