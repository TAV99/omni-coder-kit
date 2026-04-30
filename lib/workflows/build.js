'use strict';

const fs = require('fs');
const path = require('path');
const { getOverlayNameForTarget } = require('../helpers');

const PARTIALS_DIR = path.join(__dirname, '..', '..', 'templates', 'partials');
const PARTIAL_RE = /\{\{partial:([a-z0-9-]+)\}\}/g;
const AUGMENT_MARKER = '<!-- augment -->';

function resolvePartials(content) {
    return content.replace(PARTIAL_RE, (match, name) => {
        const partialPath = path.join(PARTIALS_DIR, `${name}.md`);
        if (!fs.existsSync(partialPath)) return match;
        return fs.readFileSync(partialPath, 'utf-8').trimEnd();
    });
}

function readWorkflow(src) {
    if (Array.isArray(src)) {
        const base = fs.readFileSync(src[0], 'utf-8');
        const augment = fs.readFileSync(src[1], 'utf-8')
            .replace(new RegExp('^' + AUGMENT_MARKER + '\\n?'), '');
        return base + '\n\n' + augment;
    }
    return fs.readFileSync(src, 'utf-8');
}

function getOverlayDir(ide, target = null) {
    const overlayName = target
        ? getOverlayNameForTarget(ide, target)
        : ({ claudecode: 'claude-code', dual: 'claude-code', cursor: 'cursor' }[ide] || null);
    if (!overlayName) return null;
    const dir = path.join(__dirname, '..', '..', 'templates', 'overlays', overlayName);
    return fs.existsSync(dir) ? dir : null;
}

function buildWorkflows(ide, target = null, options = {}) {
    const baseDir = path.join(__dirname, '..', '..', 'templates', 'workflows');
    const files = {};
    for (const f of fs.readdirSync(baseDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(baseDir, f);
    }
    const overlayDir = getOverlayDir(ide, target);
    if (overlayDir) {
        const overlayWorkflowDir = path.join(overlayDir, 'workflows');
        if (fs.existsSync(overlayWorkflowDir)) {
            for (const f of fs.readdirSync(overlayWorkflowDir).filter(f => f.endsWith('.md'))) {
                if (!options.subagents && f === 'coder-execution.md'
                    && path.basename(overlayDir) === 'claude-code') continue;
                const overlayPath = path.join(overlayWorkflowDir, f);
                const firstLine = fs.readFileSync(overlayPath, 'utf-8').split('\n', 1)[0];
                if (firstLine === AUGMENT_MARKER && files[f]) {
                    files[f] = [files[f], overlayPath];
                } else {
                    files[f] = overlayPath;
                }
            }
        }
    }
    return files;
}

module.exports = { getOverlayDir, buildWorkflows, resolvePartials, readWorkflow };
