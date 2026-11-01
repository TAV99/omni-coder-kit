'use strict';

// Temp project fixtures for squad P2 tests. Paths are realpath'd: on macOS
// os.tmpdir() sits behind /var -> /private/var and squad canonicalizes roots.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(t, prefix) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeSkill(dir, name, body = '') {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Test skill ${name}. Use when testing.\n---\n# ${name}\n${body}`);
}

// Fake probe reports for codex + agy (+ claude on request), shaped like registry.probe output.
function readyReports({ codexModels = ['gpt-6.1-sol'], agyModels = ['gemini-3.8-flash-high', 'claude-sonnet-4-6'], claudeModels = null } = {}) {
    const report = (id, models) => ({
        id, ready: true, detect: { found: true }, version: { ok: true, version: '1.0.0' },
        auth: { state: 'authenticated' },
        models: { ok: true, models: models.map((m) => {
            const suffix = /-(low|medium|high|xhigh|max)$/.exec(m);
            if (id === 'codex') return { id: m, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
            if (id === 'claude') return { id: m, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null };
            return { id: m, efforts: suffix ? [suffix[1]] : null, defaultEffort: suffix ? suffix[1] : null };
        }) },
    });
    const claude = claudeModels ? [{ ...report('claude', claudeModels), models: { ...report('claude', claudeModels).models, fullIdPrefix: 'claude-' } }] : [];
    return [report('codex', codexModels), report('agy', agyModels), ...claude];
}

// The real registry (real codex/agy descriptors) with probing replaced.
function registryWith(reports) {
    const { defaultRegistry } = require('../../lib/squad/runtimes');
    return { ...defaultRegistry, probeAll: async () => reports, probe: async (id) => reports.find((r) => r.id === id) };
}

module.exports = { tempDir, writeSkill, readyReports, registryWith };
