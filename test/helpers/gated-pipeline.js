'use strict';

// A pipeline that opts back into `omni squad approve` gates. The shipped templates
// have no gates since 2026-11-12 (review in chat, automatic integrate); tests of the
// gate mechanism itself write this one.

const fs = require('node:fs');
const path = require('node:path');

function gatedPipelineYaml(preset = 'dual') {
    const qcRole = preset === 'squad' ? 'reviewer' : 'orchestrator';
    return [
        'schema_version: 1',
        `preset: ${preset}`,
        'phases:',
        '  - { id: spec,      role: orchestrator, gate: human, auto_ok: true }',
        '  - { id: plan,      role: orchestrator, gate: human, auto_ok: true }',
        '  - { id: scout,     role: worker }',
        '  - { id: implement, role: worker }',
        '  - { id: review,    role: worker }',
        `  - { id: qc,        role: ${qcRole}, on_needs_fix: implement, max_corrections: 3 }`,
        '  - { id: integrate, role: orchestrator, gate: human-always }',
        '',
    ].join('\n');
}

function writeGatedPipeline(root, preset = 'dual') {
    const file = path.join(root, '.omni', 'squad', 'pipeline.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gatedPipelineYaml(preset));
    return file;
}

module.exports = { gatedPipelineYaml, writeGatedPipeline };
