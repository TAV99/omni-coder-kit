const fs = require('fs');
const path = require('path');

const PACKAGE_WORKFLOWS_DIR = path.join(__dirname, '..', '..', 'templates', 'workflows');

function resolveWorkflow(name, projectDir) {
    const customPath = path.join(projectDir, '.omni', 'workflows', name);
    if (fs.existsSync(customPath)) return customPath;
    const pkgPath = path.join(PACKAGE_WORKFLOWS_DIR, name);
    if (fs.existsSync(pkgPath)) return pkgPath;
    return null;
}

function resolveAllWorkflows(projectDir) {
    const result = {};
    if (fs.existsSync(PACKAGE_WORKFLOWS_DIR)) {
        for (const f of fs.readdirSync(PACKAGE_WORKFLOWS_DIR).filter(f => f.endsWith('.md'))) {
            result[f] = path.join(PACKAGE_WORKFLOWS_DIR, f);
        }
    }
    const customDir = path.join(projectDir, '.omni', 'workflows');
    if (fs.existsSync(customDir)) {
        for (const f of fs.readdirSync(customDir).filter(f => f.endsWith('.md'))) {
            result[f] = path.join(customDir, f);
        }
    }
    return result;
}

module.exports = { resolveWorkflow, resolveAllWorkflows };
