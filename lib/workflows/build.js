const fs = require('fs');
const path = require('path');
const { getOverlayNameForTarget } = require('../helpers');

function getOverlayDir(ide, target = null) {
    const overlayName = target
        ? getOverlayNameForTarget(ide, target)
        : ({ claudecode: 'claude-code', dual: 'claude-code', cursor: 'cursor' }[ide] || null);
    if (!overlayName) return null;
    const dir = path.join(__dirname, '..', '..', 'templates', 'overlays', overlayName);
    return fs.existsSync(dir) ? dir : null;
}

function buildWorkflows(ide, target = null) {
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
                files[f] = path.join(overlayWorkflowDir, f);
            }
        }
    }
    return files;
}

module.exports = { getOverlayDir, buildWorkflows };
